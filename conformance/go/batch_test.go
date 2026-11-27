package conformance

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
)

// A hand-built ingestion batch's pricing and upload (PROTOCOL.md 15): batch.EstimateUpload and batch.Upload.

// pdf is a small PDF's bytes, distinct for each name.
func pdf(name string) []byte { return []byte("%PDF-1.7\n" + name + ": " + string(leavePolicy)) }

// described is an item for a file's bytes, as a caller builds it: path, checksum, size and content type.
func described(p string, data []byte) caitlyn.IngestionItemInput {
	return caitlyn.IngestionItemInput{Path: caitlyn.Ptr(p), SHA256: caitlyn.Ptr(sha(data)), ByteSize: caitlyn.Ptr(int64(len(data))),
		ContentType: caitlyn.Ptr("application/pdf")}
}

// newFiles is n files under /hr/, with their items and a FilesByPath map.
func newFiles(n int) ([]caitlyn.IngestionItemInput, map[string]caitlyn.File) {
	var items []caitlyn.IngestionItemInput
	files := map[string]caitlyn.File{}
	for i := 1; i <= n; i++ {
		p := fmt.Sprintf("/hr/policy-%03d.pdf", i)
		data := pdf(p)
		items = append(items, described(p, data))
		files[p] = caitlyn.FileFromBytes(p[len("/hr/"):], data)
	}
	return items, files
}

// createBatch makes a batch of these items, to start by hand or when planned.
func createBatch(t *testing.T, c *caitlyn.Client, start caitlyn.StartMode, items []caitlyn.IngestionItemInput) *caitlyn.BatchScope {
	t.Helper()
	b, err := c.KnowledgeBase(kb).Ingestion.Batches.Create(within(t), &caitlyn.CreateIngestionBatchInput{Start: caitlyn.Ptr(start), Items: items})
	if err != nil {
		t.Fatal(err)
	}
	return b.BatchScope
}

// startedBatch is a batch of these items, planned and started by hand.
func startedBatch(t *testing.T, c *caitlyn.Client, items []caitlyn.IngestionItemInput) *caitlyn.BatchScope {
	t.Helper()
	b := createBatch(t, c, caitlyn.StartModeManual, items)
	if _, err := b.Planned(within(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Start(within(t)); err != nil {
		t.Fatal(err)
	}
	return b
}

// estimateBodies is each EstimateIngestion request's documents.
func estimateBodies(t *testing.T, m mock) [][]map[string]any {
	t.Helper()
	var out [][]map[string]any
	for _, r := range m.matching(t, pathHasSuffix("/ingestions:estimate")) {
		var docs []map[string]any
		for _, d := range jsonBody(t, r)["documents"].([]any) {
			docs = append(docs, d.(map[string]any))
		}
		out = append(out, docs)
	}
	return out
}

func names(docs []map[string]any) []string {
	var out []string
	for _, d := range docs {
		out = append(out, d["name"].(string))
	}
	sort.Strings(out)
	return out
}

// sdkError is err as an error the SDK raised itself, with this code: status 0.
func sdkError(t *testing.T, err error, code string) {
	t.Helper()
	var e *caitlyn.Error
	if !errors.As(err, &e) || e.Code != code || e.Status != 0 || e.RequestID != "" {
		t.Fatalf("got %v, want %s with status 0", err, code)
	}
}

// completed is every item id CompleteIngestionBatchUploads was sent, with the size of each call.
func completed(t *testing.T, m mock) (map[string]bool, []int) {
	t.Helper()
	ids := map[string]bool{}
	var sizes []int
	for _, r := range m.matching(t, pathHasSuffix("/complete-uploads")) {
		got := jsonBody(t, r)["itemIds"].([]any)
		sizes = append(sizes, len(got))
		for _, id := range got {
			ids[id.(string)] = true
		}
	}
	return ids, sizes
}

// itemsByPath is the batch's items by path.
func itemsByPath(t *testing.T, b *caitlyn.BatchScope) map[string]caitlyn.IngestionBatchItem {
	t.Helper()
	out := map[string]caitlyn.IngestionBatchItem{}
	for it, err := range b.Items.List(within(t), nil) {
		if err != nil {
			t.Fatal(err)
		}
		out[*it.Path] = it
	}
	return out
}

// formsFor is the form POSTs that sent these bytes.
func formsFor(t *testing.T, m mock, data []byte) int {
	t.Helper()
	n := 0
	for _, f := range m.matching(t, isForm) {
		if last := f.Form[len(f.Form)-1]; last.SHA256 == sha(data) {
			n++
		}
	}
	return n
}

var batchCases = map[string]func(t *testing.T, m mock){
	"batch-estimate.priced-items": func(t *testing.T, m mock) {
		c := client(t, m)
		changed := []byte("%PDF-1.7\nThe 2027 edition.")
		b := createBatch(t, c, caitlyn.StartModeManual, []caitlyn.IngestionItemInput{
			described("/hr/new.pdf", pdf("new")),         // new: add
			described("/policies/policy-2.pdf", changed), // changed: new_version
			{Path: caitlyn.Ptr("/policies/policy-1.pdf"), SHA256: caitlyn.Ptr(sha([]byte("doc1"))), // unchanged: skip
				ByteSize: caitlyn.Ptr[int64](1000), ContentType: caitlyn.Ptr("application/pdf")},
			{Action: caitlyn.Ptr(caitlyn.IngestionItemActionRemove), Path: caitlyn.Ptr("/policies/policy-4.pdf")}, // remove
		})
		est, err := b.EstimateUpload(within(t), nil)
		if err != nil {
			t.Fatal(err)
		}
		bodies := estimateBodies(t, m)
		if len(bodies) != 1 || !reflect.DeepEqual(names(bodies[0]), []string{"new.pdf", "policy-2.pdf"}) || est.Documents != 2 {
			t.Fatalf("priced %v, %d documents", bodies, est.Documents)
		}
	},

	"batch-estimate.from-items": func(t *testing.T, m mock) {
		c := client(t, m)
		a, bb := pdf("a"), pdf("bb")
		b := createBatch(t, c, caitlyn.StartModeManual, []caitlyn.IngestionItemInput{described("/hr/a.pdf", a), described("/hr/b.pdf", bb)})
		if _, err := b.EstimateUpload(within(t), nil); err != nil {
			t.Fatal(err)
		}
		bodies := estimateBodies(t, m)
		want := []map[string]any{
			{"name": "a.pdf", "contentType": "application/pdf", "byteSize": float64(len(a))},
			{"name": "b.pdf", "contentType": "application/pdf", "byteSize": float64(len(bb))},
		}
		if len(bodies) != 1 || !reflect.DeepEqual(bodies[0], want) {
			t.Fatalf("described %v, want %v", bodies, want)
		}
	},

	"batch-estimate.from-files": func(t *testing.T, m mock) {
		c := client(t, m)
		a, bb := pdf("a"), pdf("bb")
		b := createBatch(t, c, caitlyn.StartModeManual, []caitlyn.IngestionItemInput{described("/hr/a.pdf", a), described("/hr/b.pdf", bb)})
		var unread readCounter
		files := caitlyn.FilesByPath(map[string]caitlyn.File{
			"/hr/a.pdf": caitlyn.FileFromBytes("leave-policy.pdf", a, caitlyn.WithHints(&caitlyn.IngestionHints{Pages: caitlyn.Ptr[int64](14)})),
			// No leading slash, no hints, a stream of known size: described, never read
			"hr/b.pdf":          caitlyn.FileFromReader("handbook.pdf", &unread, caitlyn.WithSize(int64(len(bb)))),
			"/hr/elsewhere.pdf": caitlyn.FileFromBytes("elsewhere.pdf", pdf("elsewhere")),
		})
		if _, err := b.EstimateUpload(within(t), files); err != nil {
			t.Fatal(err)
		}
		bodies := estimateBodies(t, m)
		want := []map[string]any{
			{"name": "leave-policy.pdf", "contentType": "application/pdf", "byteSize": float64(len(a)), "hints": map[string]any{"pages": 14.0}},
			{"name": "handbook.pdf", "contentType": "application/pdf", "byteSize": float64(len(bb))},
		}
		if len(bodies) != 1 || !reflect.DeepEqual(bodies[0], want) {
			t.Fatalf("described %v, want %v", bodies, want)
		}
		if unread.reads != 0 {
			t.Fatalf("a file was read %d times for the estimate", unread.reads)
		}
	},

	"batch-estimate.draft": func(t *testing.T, m mock) {
		c := client(t, m)
		created, err := c.KnowledgeBase(kb).Ingestion.Batches.Create(within(t), &caitlyn.CreateIngestionBatchInput{Start: caitlyn.Ptr(caitlyn.StartModeManual),
			AwaitMoreItems: caitlyn.Ptr(true), Items: []caitlyn.IngestionItemInput{described("/hr/a.pdf", pdf("a"))}})
		if err != nil {
			t.Fatal(err)
		}
		_, err = created.EstimateUpload(within(t), nil)
		sdkError(t, err, "INGESTION_BATCH_NOT_PLANNED")
		if n := len(m.matching(t, pathHasSuffix("/ingestions:estimate"))); n != 0 {
			t.Fatalf("%d estimates sent", n)
		}
	},

	"batch-estimate.planning": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"planningReads": 2})
		c := client(t, m)
		b := createBatch(t, c, caitlyn.StartModeManual, []caitlyn.IngestionItemInput{described("/hr/a.pdf", pdf("a"))})
		if got, err := b.Get(within(t)); err != nil || got.Status != caitlyn.IngestionBatchStatusPlanning {
			t.Fatalf("batch %+v, %v; want planning", got, err)
		}
		est, err := b.EstimateUpload(within(t), nil)
		if err != nil || est.Documents != 1 {
			t.Fatalf("estimate %+v, %v", est, err)
		}
		reqs := m.api(t)
		watch := slices.IndexFunc(reqs, pathHasSuffix("/events"))
		estimate := slices.IndexFunc(reqs, pathHasSuffix("/ingestions:estimate"))
		if watch < 0 || estimate < watch {
			t.Fatalf("watched at %d, priced at %d", watch, estimate)
		}
	},

	"batch-estimate.nothing-to-price": func(t *testing.T, m mock) {
		c := client(t, m)
		b := createBatch(t, c, caitlyn.StartModeManual, []caitlyn.IngestionItemInput{
			{Path: caitlyn.Ptr("/policies/policy-1.pdf"), SHA256: caitlyn.Ptr(sha([]byte("doc1"))), ByteSize: caitlyn.Ptr[int64](1000),
				ContentType: caitlyn.Ptr("application/pdf")},
		})
		est, err := b.EstimateUpload(within(t), nil)
		if err != nil || est == nil || est.Documents != 0 || est.Cost != nil {
			t.Fatalf("estimate %+v, %v; want empty", est, err)
		}
		if n := len(m.matching(t, pathHasSuffix("/ingestions:estimate"))); n != 0 {
			t.Fatalf("%d estimates sent", n)
		}
	},

	"batch-estimate.many": func(t *testing.T, m mock) {
		c := client(t, m)
		items, _ := newFiles(5)
		b := createBatch(t, c, caitlyn.StartModeManual, items)
		// A limit of 2 in place of 10,000, so five items take three calls
		est, err := b.EstimateUpload(caitlyn.WithEstimatePerCall(within(t), 2), nil)
		if err != nil {
			t.Fatal(err)
		}
		var sizes []int
		for _, docs := range estimateBodies(t, m) {
			sizes = append(sizes, len(docs))
		}
		if !reflect.DeepEqual(sizes, []int{2, 2, 1}) || est.Documents != 5 || est.Details != nil {
			t.Fatalf("calls of %v, %+v", sizes, est)
		}
	},

	"batch-upload.not-started": func(t *testing.T, m mock) {
		c := client(t, m)
		items, files := newFiles(2)
		// Planned, to start by hand: refused, nothing sent
		b := createBatch(t, c, caitlyn.StartModeManual, items)
		if _, err := b.Planned(within(t)); err != nil {
			t.Fatal(err)
		}
		_, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil)
		sdkError(t, err, "INGESTION_BATCH_NOT_STARTED")
		if n := len(m.matching(t, isForm)) + len(m.matching(t, pathHasSuffix("/upload-policies"))); n != 0 {
			t.Fatalf("%d upload requests sent", n)
		}
		// A draft: refused too
		draft, err := c.KnowledgeBase(kb).Ingestion.Batches.Create(within(t), &caitlyn.CreateIngestionBatchInput{Start: caitlyn.Ptr(caitlyn.StartModeManual),
			AwaitMoreItems: caitlyn.Ptr(true), Items: items})
		if err != nil {
			t.Fatal(err)
		}
		_, err = draft.Upload(within(t), caitlyn.FilesByPath(files), nil)
		sdkError(t, err, "INGESTION_BATCH_NOT_STARTED")
		// Started when planned: followed until running, then uploaded
		m = fresh(t)
		m.faults(t, map[string]any{"planningReads": 2})
		c = client(t, m)
		wp := createBatch(t, c, caitlyn.StartModeWhenPlanned, items)
		up, err := wp.Upload(within(t), caitlyn.FilesByPath(files), nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(up.Result.Items) != 2 || len(m.matching(t, isForm)) != 2 {
			t.Fatalf("uploaded %+v with %d forms", up.Result.Items, len(m.matching(t, isForm)))
		}
		// Started when planned but stopped at planned, an item unresolved: refused
		m = fresh(t)
		m.faults(t, map[string]any{"planConflicts": map[string]any{"/hr/policy-001.pdf": "path_taken"}})
		c = client(t, m)
		stuck := createBatch(t, c, caitlyn.StartModeWhenPlanned, items)
		_, err = stuck.Upload(within(t), caitlyn.FilesByPath(files), nil)
		sdkError(t, err, "INGESTION_BATCH_NOT_STARTED")
		if n := len(m.matching(t, isForm)); n != 0 {
			t.Fatalf("%d forms sent", n)
		}
	},

	"batch-upload.sends": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"uploadDelayMs": 150})
		c := client(t, m)
		items, files := newFiles(14)
		items = append(items, described("/hr/not-given.pdf", pdf("not given")))
		b := startedBatch(t, c, items)
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil)
		if err != nil {
			t.Fatal(err)
		}
		if n := m.uploads(t).MaxInFlight; n != 6 {
			t.Fatalf("at most %d uploads at once, want 6", n)
		}
		forms := m.matching(t, isForm)
		if len(forms) != 14 || len(up.Result.Items) != 14 {
			t.Fatalf("%d forms, %d items", len(forms), len(up.Result.Items))
		}
		for _, f := range forms {
			var got []string
			for _, p := range f.Form {
				got = append(got, p.Name)
			}
			tail := []string{"key", "Content-Type", "x-amz-checksum-algorithm", "x-amz-checksum-sha256", "file"}
			if len(got) < len(tail) || !reflect.DeepEqual(got[len(got)-len(tail):], tail) {
				t.Fatalf("form fields %v", got)
			}
		}
		// CompleteIngestionBatchUploads in groups of at most 100
		m = fresh(t)
		c = client(t, m)
		items, files = newFiles(250)
		b = startedBatch(t, c, items)
		if _, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil); err != nil {
			t.Fatal(err)
		}
		ids, sizes := completed(t, m)
		for _, n := range sizes {
			if n == 0 || n > 100 {
				t.Fatalf("a Complete call named %d items", n)
			}
		}
		if len(ids) != 250 {
			t.Fatalf("completed %d items of 250", len(ids))
		}
	},

	"batch-upload.not-given": func(t *testing.T, m mock) {
		c := client(t, m)
		items, files := newFiles(2)
		delete(files, "/hr/policy-002.pdf")
		b := startedBatch(t, c, items)
		var onItem []string
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), &caitlyn.BatchUploadOptions{OnItem: func(it caitlyn.IngestionBatchItem) {
			onItem = append(onItem, *it.Path)
		}})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(up.Result.NotGiven, []string{"/hr/policy-002.pdf"}) || len(onItem) != 0 {
			t.Fatalf("not given %v, OnItem %v", up.Result.NotGiven, onItem)
		}
		left := itemsByPath(t, b)["/hr/policy-002.pdf"]
		ids, _ := completed(t, m)
		if left.Status != caitlyn.IngestionItemStatusAwaitingUpload || ids[left.ID] || len(ids) != 1 {
			t.Fatalf("the item with no file %+v, completed %v", left, ids)
		}
	},

	"batch-upload.unmatched": func(t *testing.T, m mock) {
		c := client(t, m)
		items, _ := newFiles(2)
		b := startedBatch(t, c, items)
		up, err := b.Upload(within(t), caitlyn.FilesByPath(map[string]caitlyn.File{
			"/hr/policy-001.pdf": caitlyn.FileFromBytes("policy-001.pdf", pdf("/hr/policy-001.pdf")),
			"hr/policy-002.pdf":  caitlyn.FileFromBytes("policy-002.pdf", pdf("/hr/policy-002.pdf")), // without its leading /
			"/hr/nowhere.pdf":    caitlyn.FileFromBytes("nowhere.pdf", pdf("nowhere")),
		}), nil)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(up.Result.Unmatched, []string{"/hr/nowhere.pdf"}) || len(up.Result.NotGiven) != 0 {
			t.Fatalf("unmatched %v, not given %v", up.Result.Unmatched, up.Result.NotGiven)
		}
		if n := len(m.matching(t, isForm)); n != 2 || formsFor(t, m, pdf("nowhere")) != 0 {
			t.Fatalf("%d forms", n)
		}
	},

	"batch-upload.file-changed": func(t *testing.T, m mock) {
		c := client(t, m)
		items, files := newFiles(3)
		b := startedBatch(t, c, items)
		short := []byte("%PDF-1.7\nshorter")
		sameSize := []byte(strings.Repeat("x", len(pdf("/hr/policy-002.pdf"))))
		files["/hr/policy-001.pdf"] = caitlyn.FileFromBytes("policy-001.pdf", short)
		files["/hr/policy-002.pdf"] = caitlyn.FileFromBytes("policy-002.pdf", sameSize)
		var onItem []caitlyn.IngestionBatchItem
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), &caitlyn.BatchUploadOptions{OnItem: func(it caitlyn.IngestionBatchItem) {
			onItem = append(onItem, it)
		}})
		if err != nil {
			t.Fatal(err)
		}
		status := map[string]caitlyn.IngestionBatchItem{}
		for _, it := range up.Result.Items {
			status[*it.Path] = it
		}
		for _, p := range []string{"/hr/policy-001.pdf", "/hr/policy-002.pdf"} {
			if it := status[p]; it.Status != caitlyn.IngestionItemStatusFailed || it.FailureCode == nil || *it.FailureCode != "FILE_CHANGED" {
				t.Fatalf("%s: %+v", p, it)
			}
		}
		if status["/hr/policy-003.pdf"].Status != caitlyn.IngestionItemStatusIngesting || len(onItem) != 2 {
			t.Fatalf("the other upload %+v, OnItem %d", status["/hr/policy-003.pdf"], len(onItem))
		}
		// The wrong size is never sent; the wrong bytes are sent once, refused, and not sent again
		if formsFor(t, m, short) != 0 || formsFor(t, m, sameSize) != 1 {
			t.Fatalf("sent the short file %d times, the changed one %d times", formsFor(t, m, short), formsFor(t, m, sameSize))
		}
	},

	"batch-upload.upload-failed": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"failUploads": map[string]any{"/hr/policy-002.pdf": true}})
		c := client(t, m)
		items, files := newFiles(2)
		b := startedBatch(t, c, items)
		var onItem []caitlyn.IngestionBatchItem
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), &caitlyn.BatchUploadOptions{OnItem: func(it caitlyn.IngestionBatchItem) {
			onItem = append(onItem, it)
		}})
		if err != nil {
			t.Fatal(err)
		}
		if len(onItem) != 1 || *onItem[0].Path != "/hr/policy-002.pdf" || *onItem[0].FailureCode != "UPLOAD_FAILED" {
			t.Fatalf("OnItem %+v", onItem)
		}
		var failedID string
		for _, it := range up.Result.Items {
			if *it.Path == "/hr/policy-002.pdf" {
				failedID = it.ID
				if it.Status != caitlyn.IngestionItemStatusFailed {
					t.Fatalf("failed item %+v", it)
				}
			} else if it.Status != caitlyn.IngestionItemStatusIngesting {
				t.Fatalf("other item %+v", it)
			}
		}
		if ids, _ := completed(t, m); failedID == "" || ids[failedID] || len(ids) != 1 {
			t.Fatalf("completed %v", ids)
		}
	},

	"batch-upload.policy-renewal": func(t *testing.T, m mock) {
		// The call's own policy lasts a second, so its renewal margin is half a second; each file takes a second to arrive,
		// one at a time. The first goes with that policy; it is renewed before the second goes.
		m.faults(t, map[string]any{"renewedPolicySeconds": 1, "uploadDelayMs": 1000})
		c := client(t, m)
		items, files := newFiles(2)
		b := startedBatch(t, c, items)
		before := len(m.requests(t))
		if _, err := b.Upload(within(t), caitlyn.FilesByPath(files), &caitlyn.BatchUploadOptions{Concurrency: 1}); err != nil {
			t.Fatal(err)
		}
		if order := uploadOrder(m.requests(t)[before:]); order != "policy upload policy upload" {
			t.Fatalf("POSTs %q; want the call's own policy, then its renewal between the uploads", order)
		}
		// A 403 that says the policy expired: renewed once, and that file sent again
		m = fresh(t)
		m.faults(t, map[string]any{"firstCreatedPolicyExpired": true})
		c = client(t, m)
		b = startedBatch(t, c, items)
		before = len(m.matching(t, pathHasSuffix("/upload-policies")))
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), &caitlyn.BatchUploadOptions{Concurrency: 1})
		if err != nil {
			t.Fatal(err)
		}
		if n := len(m.matching(t, pathHasSuffix("/upload-policies"))) - before; n != 2 {
			t.Fatalf("%d policies, want the call's own and one renewal", n)
		}
		if objects := m.uploads(t).Objects; len(objects) != 2 || len(up.Result.Items) != 2 {
			t.Fatalf("%d objects stored, %d items", len(objects), len(up.Result.Items))
		}
		if forms := m.matching(t, isForm); len(forms) != 3 || forms[0].Form[len(forms[0].Form)-1].SHA256 != forms[1].Form[len(forms[1].Form)-1].SHA256 {
			t.Fatalf("%d form POSTs, want the refused file again and then the other", len(forms))
		}
	},

	"batch-upload.checksum-mismatch": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"checksumMismatch": map[string]any{"/hr/policy-001.pdf": 1, "/hr/policy-002.pdf": 2}})
		c := client(t, m)
		items, files := newFiles(2)
		b := startedBatch(t, c, items)
		var onItem []string
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), &caitlyn.BatchUploadOptions{OnItem: func(it caitlyn.IngestionBatchItem) {
			onItem = append(onItem, *it.Path)
		}})
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]caitlyn.IngestionBatchItem{}
		for _, it := range up.Result.Items {
			got[*it.Path] = it
		}
		// Once: uploaded again and accepted. Twice: failed
		if formsFor(t, m, pdf("/hr/policy-001.pdf")) != 2 || got["/hr/policy-001.pdf"].Status != caitlyn.IngestionItemStatusIngesting {
			t.Fatalf("one mismatch: %+v", got["/hr/policy-001.pdf"])
		}
		second := got["/hr/policy-002.pdf"]
		if formsFor(t, m, pdf("/hr/policy-002.pdf")) != 2 || second.Status != caitlyn.IngestionItemStatusFailed || *second.FailureCode != "CHECKSUM_MISMATCH" ||
			!reflect.DeepEqual(onItem, []string{"/hr/policy-002.pdf"}) {
			t.Fatalf("two mismatches: %+v, OnItem %v", second, onItem)
		}
	},

	"batch-upload.second-call": func(t *testing.T, m mock) {
		c := client(t, m)
		items, files := newFiles(2)
		b := startedBatch(t, c, items)
		first := map[string]caitlyn.File{"/hr/policy-001.pdf": files["/hr/policy-001.pdf"]}
		if _, err := b.Upload(within(t), caitlyn.FilesByPath(first), nil); err != nil {
			t.Fatal(err)
		}
		_, again := newFiles(2)
		up, err := b.Upload(within(t), caitlyn.FilesByPath(again), nil)
		if err != nil {
			t.Fatal(err)
		}
		if formsFor(t, m, pdf("/hr/policy-001.pdf")) != 1 || formsFor(t, m, pdf("/hr/policy-002.pdf")) != 1 || len(up.Result.Items) != 1 ||
			*up.Result.Items[0].Path != "/hr/policy-002.pdf" || !reflect.DeepEqual(up.Result.Unmatched, []string{"/hr/policy-001.pdf"}) {
			t.Fatalf("second call %+v", up.Result)
		}
	},

	"batch-upload.result": func(t *testing.T, m mock) {
		c := client(t, m)
		items, files := newFiles(2)
		b := startedBatch(t, c, items)
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil)
		if err != nil {
			t.Fatal(err)
		}
		var result *caitlyn.BatchUpload = up.Result
		var batch *caitlyn.IngestionBatch = result.Batch
		// The batch as it stood when the call ended: running, or already finished if ingestion was that quick
		if batch.ID != b.ID() || (batch.Status != caitlyn.IngestionBatchStatusRunning && batch.Status != caitlyn.IngestionBatchStatusSucceeded) ||
			len(result.Items) != 2 || len(result.NotGiven) != 0 || len(result.Unmatched) != 0 {
			t.Fatalf("result %+v", result)
		}
		for _, it := range result.Items {
			if it.Status != caitlyn.IngestionItemStatusIngesting {
				t.Fatalf("item %+v", it)
			}
		}
		var done *caitlyn.IngestionBatch
		if done, err = up.Wait(within(t)); err != nil || done.ID != b.ID() || done.Status != caitlyn.IngestionBatchStatusSucceeded {
			t.Fatalf("waited %+v, %v", done, err)
		}
	},

	"batch-upload.cancel": func(t *testing.T, m mock) {
		// Every upload is held at storage until the client lets go of it (at most 10 s): cancelling aborts those in
		// flight at once, without waiting for them
		m.faults(t, map[string]any{"holdUploadsAfter": 0})
		c := client(t, m)
		items, files := newFiles(12)
		b := startedBatch(t, c, items)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		var cancelledAt time.Time
		go func() {
			// Once the first six are in flight
			for m.uploads(t).MaxInFlight < 6 {
				time.Sleep(10 * time.Millisecond)
			}
			cancelledAt = time.Now()
			cancel()
		}()
		_, err := b.Upload(ctx, caitlyn.FilesByPath(files), nil)
		// Returned without waiting for the uploads: they were held until the client let go of them, so any that had been
		// waited for would have been stored when the hold ended. None was (below).
		if cancelledAt.IsZero() {
			t.Fatal("returned before the cancellation")
		}
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v, want context.Canceled", err)
		}
		if n := len(m.matching(t, pathHasSuffix("/cancel"))); n != 0 {
			t.Fatalf("%d CancelIngestionBatch sent", n)
		}
		if n := len(m.uploads(t).Objects); n != 0 {
			t.Fatalf("%d uploads finished", n)
		}
	},
}

func init() {
	batchCases["sync.estimate-unresolved"] = func(t *testing.T, m mock) {
		// An unchanged file (skip), a new one (add) and a conflict the policy leaves unresolved: the last is priced
		// too, as the most the batch could cost
		m.faults(t, map[string]any{"planConflicts": map[string]any{"/policies/clash.pdf": "path_taken"}})
		c := client(t, m)
		resolved := false
		var confirmed *caitlyn.EstimateIngestionResult
		_, err := c.KnowledgeBase(kb).Ingestion.Sync(within(t), caitlyn.Files{
			{RelativePath: "policy-1.pdf", File: caitlyn.FileFromBytes("policy-1.pdf", []byte("doc1"))},
			{RelativePath: "new.pdf", File: caitlyn.FileFromBytes("new.pdf", pdf("new"))},
			{RelativePath: "clash.pdf", File: caitlyn.FileFromBytes("clash.pdf", pdf("clash"))},
		}, &caitlyn.SyncOptions{Folder: "/policies/",
			Confirm: func(_ context.Context, plan *caitlyn.SyncPlan) (bool, error) {
				if resolved {
					t.Error("the resolver ran before Confirm")
				}
				confirmed = plan.Estimate
				return true, nil
			},
			Resolve: func(context.Context, caitlyn.IngestionBatchItem) (caitlyn.IngestionItemResolution, error) {
				resolved = true
				return caitlyn.IngestionItemResolutionSkip, nil
			}})
		if err != nil {
			t.Fatal(err)
		}
		bodies := estimateBodies(t, m)
		if confirmed == nil || confirmed.Documents != 2 || len(bodies) != 1 || !reflect.DeepEqual(names(bodies[0]), []string{"clash.pdf", "new.pdf"}) || !resolved {
			t.Fatalf("Confirm saw %+v; priced %v", confirmed, bodies)
		}
		// batch.EstimateUpload prices the same items
		m = fresh(t)
		m.faults(t, map[string]any{"planConflicts": map[string]any{"/policies/clash.pdf": "path_taken"}})
		c = client(t, m)
		b := createBatch(t, c, caitlyn.StartModeManual, []caitlyn.IngestionItemInput{
			{Path: caitlyn.Ptr("/policies/policy-1.pdf"), SHA256: caitlyn.Ptr(sha([]byte("doc1"))), ByteSize: caitlyn.Ptr[int64](4),
				ContentType: caitlyn.Ptr("application/pdf")},
			described("/policies/new.pdf", pdf("new")),
			described("/policies/clash.pdf", pdf("clash")),
		})
		est, err := b.EstimateUpload(within(t), nil)
		bodies = estimateBodies(t, m)
		if err != nil || est.Documents != 2 || len(bodies) != 1 || !reflect.DeepEqual(names(bodies[0]), []string{"clash.pdf", "new.pdf"}) {
			t.Fatalf("EstimateUpload %+v, %v; priced %v", est, err, bodies)
		}
	}
	for id, run := range batchCases {
		protocol[id] = run
	}
}

// TestGoStartedHandles: the calls the model now marks @longRunning return handles whose Wait follows the work.
func TestGoStartedHandles(t *testing.T) {
	m := fresh(t)
	c := client(t, m)
	ctx := within(t)
	items, files := newFiles(2)
	// CreateIngestionBatch: the new batch's scope, with Wait
	created, err := c.KnowledgeBase(kb).Ingestion.Batches.Create(ctx, &caitlyn.CreateIngestionBatchInput{Start: caitlyn.Ptr(caitlyn.StartModeManual), Items: items})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := created.Planned(ctx); err != nil {
		t.Fatal(err)
	}
	// StartIngestionBatch: the response (the batch and its upload policy) as Result, and Wait to the batch's end
	started, err := created.Start(ctx)
	if err != nil || started.Result.UploadPolicy == nil || started.Result.Batch.Status != caitlyn.IngestionBatchStatusRunning {
		t.Fatalf("started %+v, %v", started, err)
	}
	if _, err := created.Upload(ctx, caitlyn.FilesByPath(files), nil); err != nil {
		t.Fatal(err)
	}
	done, err := started.Wait(ctx)
	if err != nil || done.ID != created.ID() || done.Status != caitlyn.IngestionBatchStatusSucceeded {
		t.Fatalf("start's wait %+v, %v", done, err)
	}
	// CancelIngestionBatch: the cancelled batch as Result, and Wait until it has stopped
	other := startedBatch(t, c, []caitlyn.IngestionItemInput{described("/hr/not-yet.pdf", pdf("not yet"))}) // awaits its upload
	cancelled, err := other.Cancel(ctx, nil)
	if err != nil || cancelled.Result.ID != other.ID() {
		t.Fatalf("cancelled %+v, %v", cancelled, err)
	}
	if b, err := cancelled.Wait(ctx); err == nil && b.Status != caitlyn.IngestionBatchStatusCancelled {
		t.Fatalf("cancel's wait %+v", b)
	} else if err != nil {
		sdkError(t, err, "CANCELLED")
	}
	// CancelDocumentProcessing: the document as Result, and Wait until nothing runs on it ([wait.cancel-returns]
	// checks what that Wait gives)
	m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}, "holdJobs": map[string]any{"doc-0001": true}, "cancellableProcessing": true})
	stopped, err := c.KnowledgeBase(kb).Document("doc-0001").CancelProcessing(ctx)
	if err != nil || stopped.Result.ID != "doc-0001" || stopped.Result.ETag == "" {
		t.Fatalf("cancel processing %+v, %v", stopped, err)
	}
	var _ func(context.Context, ...caitlyn.WaitOption) (*caitlyn.Document, error) = stopped.Wait
}

func init() {
	protocol["wait.cancel-returns"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		// batch.Cancel(…).Wait: the batch, cancelled, and no CANCELLED for the work the call cancelled
		b := startedBatch(t, c, []caitlyn.IngestionItemInput{described("/hr/not-yet.pdf", pdf("not yet"))})
		cancelled, err := b.Cancel(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		var batch *caitlyn.IngestionBatch
		if batch, err = cancelled.Wait(ctx); err != nil || batch.ID != b.ID() || batch.Status != caitlyn.IngestionBatchStatusCancelled {
			t.Fatalf("cancel's wait %+v, %v", batch, err)
		}
		// Every other wait still raises CANCELLED for it
		_, err = b.Wait(ctx)
		sdkError(t, err, "CANCELLED")
		// doc.CancelProcessing(…).Wait: the document as it then stands, its processing cancelled
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}, "holdJobs": map[string]any{"doc-0001": true}, "cancellableProcessing": true})
		stopped, err := c.KnowledgeBase(kb).Document("doc-0001").CancelProcessing(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var doc *caitlyn.Document
		if doc, err = stopped.Wait(ctx); err != nil || doc.ID != "doc-0001" {
			t.Fatalf("cancel processing's wait %+v, %v", doc, err)
		}
	}
}
