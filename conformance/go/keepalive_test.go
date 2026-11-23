package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
)

// The upload keep-alive (PROTOCOL.md 15, batch-upload.keep-alive).

func init() {
	protocol["batch-upload.keep-alive"] = func(t *testing.T, m mock) {
		// A compressed clock: each policy lasts 2 s, so it is due for renewal 1 s after it arrives (half its life), and the
		// batch stops waiting for bytes 2 s after the latest one. The one file takes 3 s to arrive.
		renewals := func() int {
			return len(m.matching(t, func(r logged) bool { return r.Method == "POST" && pathHasSuffix("/upload-policies")(r) }))
		}
		faults := map[string]any{"uploadReservation": map[string]any{"policySeconds": 2, "reservationSeconds": 2}, "uploadDelayMs": 3000}
		m.faults(t, faults)
		c := client(t, m)
		items, files := newFiles(1)
		b := startedBatch(t, c, items)
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(up.Result.Items) != 1 || up.Result.Items[0].Status != caitlyn.IngestionItemStatusIngesting {
			t.Fatalf("items %+v; want the one accepted, not UPLOAD_EXPIRED", up.Result.Items)
		}
		sent := renewals()
		if sent < 3 {
			t.Fatalf("%d policies asked for; want the first, then at least two while the upload was in flight", sent)
		}
		time.Sleep(1500 * time.Millisecond)
		if n := renewals(); n != sent {
			t.Fatalf("%d renewals after the call returned", n-sent)
		}

		// Cancelled during the slow upload: no renewal after the cancellation is returned.
		m = fresh(t)
		m.faults(t, faults)
		c = client(t, m)
		b = startedBatch(t, c, items)
		ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		defer cancel()
		_, err = b.Upload(ctx, caitlyn.FilesByPath(files), nil)
		if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v; want the context's error", err)
		}
		atCancel := renewals()
		time.Sleep(1500 * time.Millisecond)
		if n := renewals(); n != atCancel {
			t.Fatalf("%d renewals after the cancellation", n-atCancel)
		}
	}

	protocol["batch-upload.keep-alive-floor"] = func(t *testing.T, m mock) {
		// Every policy lasts a second, so it is due half a second after it arrives; the one file takes 4 s to arrive. The
		// first ask is Upload's own policy; the rest are the timer's, the first half a second on and the others a second
		// apart: about five in all, where half-second renewals would be about nine.
		m.faults(t, map[string]any{"uploadReservation": map[string]any{"policySeconds": 1, "reservationSeconds": 30}, "uploadDelayMs": 4000})
		c := client(t, m)
		items, files := newFiles(1)
		b := startedBatch(t, c, items)
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(up.Result.Items) != 1 || up.Result.Items[0].Status != caitlyn.IngestionItemStatusIngesting {
			t.Fatalf("items %+v", up.Result.Items)
		}
		var at []int64
		for _, r := range m.matching(t, func(r logged) bool { return r.Method == "POST" && pathHasSuffix("/upload-policies")(r) }) {
			at = append(at, r.At)
		}
		if len(at) < 4 || len(at) > 6 {
			t.Fatalf("%d policies asked for in 4 s: want the timer's renewals, at most one a second", len(at))
		}
		for i := 2; i < len(at); i++ {
			if at[i]-at[i-1] < 900 {
				t.Fatalf("renewals %d ms apart (%v)", at[i]-at[i-1], at)
			}
		}
	}

	protocol["batch-upload.short-window"] = func(t *testing.T, m mock) {
		// A 60-second window that the mock's test mode makes 2 s long, and one file that takes 2.5 s to arrive. Each policy lasts 2 s, so its renewal margin is 1 s, not 5 minutes: renewals about 1 s apart.
		m.faults(t, map[string]any{"shortWindows": true, "uploadDelayMs": 2500})
		c := client(t, m)
		report, err := c.KnowledgeBase(kb).Ingestion.Sync(within(t), caitlyn.Files{
			{RelativePath: "annual-leave.pdf", File: caitlyn.FileFromBytes("annual-leave.pdf", pdf("annual leave"))},
		}, &caitlyn.SyncOptions{Folder: "/window/", UploadWindowSeconds: 60})
		if err != nil {
			t.Fatal(err)
		}
		if report.Batch.Status != caitlyn.IngestionBatchStatusSucceeded {
			t.Fatalf("batch %s", report.Batch.Status)
		}
		created := m.matching(t, func(r logged) bool { return r.Method == "POST" && strings.HasSuffix(r.Path, "/ingestion-batches") })
		var body map[string]any
		if len(created) == 0 || json.Unmarshal([]byte(created[0].Body), &body) != nil || body["uploadWindowSeconds"] != float64(60) {
			t.Fatalf("CreateIngestionBatch sent %v; want uploadWindowSeconds 60", body)
		}
		var at []int64
		for _, r := range m.matching(t, func(r logged) bool { return r.Method == "POST" && pathHasSuffix("/upload-policies")(r) }) {
			at = append(at, r.At)
		}
		if len(at) < 1 || len(at) > 3 {
			t.Fatalf("%d renewals in a 2.5 s upload under 2 s policies", len(at))
		}
		for i := 1; i < len(at); i++ {
			if at[i]-at[i-1] < 750 {
				t.Fatalf("renewals %d ms apart (%v)", at[i]-at[i-1], at)
			}
		}
		// ExpiresInSeconds on a single file's upload, as given.
		before := time.Now()
		up, err := c.Core.Uploads.Reserve(within(t), &caitlyn.CreateUploadInput{FileName: "a.pdf", ContentType: "application/pdf", ByteSize: 1, SHA256: sha([]byte("a")), ExpiresInSeconds: caitlyn.Ptr(int32(60))})
		if err != nil {
			t.Fatal(err)
		}
		if life := up.ExpiresAt.Sub(before); life < 55*time.Second || life > 65*time.Second {
			t.Fatalf("the upload lasts %s; want about a minute", life)
		}
	}
}

func init() {
	protocol["watch.snapshot-not-progress"] = func(t *testing.T, m mock) {
		c := client(t, m)
		watches := func() int {
			return len(m.matching(t, func(r logged) bool { return r.Method == "GET" && r.Path == kbPath+"/events" }))
		}
		// Four connections in a row that each end after their snapshot (a fresh id every time): STREAM_LOST.
		m.faults(t, map[string]any{"watchDrops": map[string]any{"count": 4, "afterEvents": 1}})
		w, err := c.KnowledgeBase(kb).Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		var seen []string
		var failed error
		for ev, err := range w.Events() {
			if err != nil {
				failed = err
				break
			}
			seen = append(seen, ev.EventType())
		}
		w.Close()
		var ae *caitlyn.Error
		if !errors.As(failed, &ae) || ae.Code != "STREAM_LOST" || strings.Join(seen, ",") != "snapshot,snapshot,snapshot,snapshot" || watches() != 4 {
			t.Fatalf("events %v, error %v, %d connections; want four snapshots, then STREAM_LOST after three reconnects", seen, failed, watches())
		}
		// Three such connections, then one that stays open and brings a change: the watch carries on to it.
		m = fresh(t)
		m.faults(t, map[string]any{"watchDrops": map[string]any{"count": 3, "afterEvents": 1}})
		c = client(t, m)
		go func() {
			for watches() < 4 {
				time.Sleep(50 * time.Millisecond)
			}
			time.Sleep(100 * time.Millisecond)
			if current, err := c.KnowledgeBase(kb).Get(context.Background()); err == nil {
				_, _ = c.KnowledgeBase(kb).Update(context.Background(), &caitlyn.UpdateKnowledgeBaseInput{Description: caitlyn.Ptr("Still watching")}, caitlyn.WithIfMatch(current.ETag))
			}
		}()
		w, err = c.KnowledgeBase(kb).Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		seen = nil
		for ev, err := range w.Events() {
			if err != nil {
				t.Fatalf("the watch failed after %v: %v", seen, err)
			}
			seen = append(seen, ev.EventType())
			if ev.EventType() == "knowledge_base.updated" {
				break
			}
		}
		if strings.Join(seen, ",") != "snapshot,snapshot,snapshot,snapshot,knowledge_base.updated" {
			t.Fatalf("events %v", seen)
		}
	}
}

// uploadOrder is the order of the storage form POSTs ("upload") and upload policy requests ("policy") among reqs.
func uploadOrder(reqs []logged) string {
	var order []string
	for _, r := range reqs {
		switch {
		case isForm(r):
			order = append(order, "upload")
		case r.Method == "POST" && pathHasSuffix("/upload-policies")(r):
			order = append(order, "policy")
		}
	}
	return strings.Join(order, " ")
}
