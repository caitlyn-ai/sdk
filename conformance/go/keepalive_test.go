package conformance

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
)

// The upload keep-alive (PROTOCOL.md 15, batch-upload.keep-alive).

func init() {
	protocol["batch-upload.keep-alive"] = func(t *testing.T, m mock) {
		// A compressed clock: each policy is due for renewal 2 s after it is issued, and the batch stops waiting for
		// bytes 4 s after the latest one. The one file takes 6 s to arrive.
		renewals := func() int {
			return len(m.matching(t, func(r logged) bool { return r.Method == "POST" && pathHasSuffix("/upload-policies")(r) }))
		}
		faults := map[string]any{"uploadReservation": map[string]any{"policySeconds": 302, "reservationSeconds": 4}, "uploadDelayMs": 6000}
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
		time.Sleep(2500 * time.Millisecond)
		if n := renewals(); n != sent {
			t.Fatalf("%d renewals after the call returned", n-sent)
		}

		// Cancelled during the slow upload: no renewal after the cancellation is returned.
		m = fresh(t)
		m.faults(t, faults)
		c = client(t, m)
		b = startedBatch(t, c, items)
		ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
		defer cancel()
		_, err = b.Upload(ctx, caitlyn.FilesByPath(files), nil)
		if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v; want the context's error", err)
		}
		atCancel := renewals()
		time.Sleep(2500 * time.Millisecond)
		if n := renewals(); n != atCancel {
			t.Fatalf("%d renewals after the cancellation", n-atCancel)
		}
	}
}
