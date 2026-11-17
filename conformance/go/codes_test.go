package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	"github.com/caitlyn-ai/sdk/go"
)

// The codes the SDK raises itself for failures during a call (PROTOCOL.md 6.3): each a *caitlyn.Error with status 0,
// the native error kept as its Cause and reached through errors.Unwrap.

// failingReader gives some bytes, then fails, as a disk going away would.
type failingReader struct {
	sent bool
	err  error
}

func (r *failingReader) Read(b []byte) (int, error) {
	if !r.sent {
		r.sent = true
		return copy(b, "%PDF-1.7 first part"), nil
	}
	return 0, r.err
}

func init() {
	protocol["errors.decode-failed"] = func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"status": map[string]any{"GetDocument": []any{map[string]any{"status": 200, "body": "this is not JSON", "contentType": "application/json"}}}})
		_, err := client(t, m).KnowledgeBase(kb).Document("doc-0001").Get(context.Background())
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "DECODE_FAILED" || e.Status != 0 {
			t.Fatalf("got %v; want DECODE_FAILED with status 0", err)
		}
		var syntax *json.SyntaxError
		if !errors.As(e.Cause, &syntax) || errors.Unwrap(e) != e.Cause {
			t.Fatalf("cause %T %v; want the *json.SyntaxError, through Unwrap", e.Cause, e.Cause)
		}
	}
	protocol["errors.job-failed-no-code"] = func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0002": true}, "jobOutcomes": map[string]any{"doc-0002": "failed"},
			"jobError": map[string]any{"detail": "The job failed and said no more."}})
		_, err := client(t, m).KnowledgeBase(kb).Document("doc-0002").Wait(within(t))
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "JOB_FAILED" || e.Status != 0 {
			t.Fatalf("got %T %v; want JOB_FAILED with status 0", err, err)
		}
	}
	protocol["errors.file-unreadable"] = func(t *testing.T, m mock) {
		c := client(t, m)
		broken := errors.New("the disk went away")
		_, err := c.Core.Uploads.Send(context.Background(), caitlyn.FileFromReader("scan.pdf", &failingReader{err: broken}), nil)
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "FILE_UNREADABLE" || e.Status != 0 || !errors.Is(err, broken) {
			t.Fatalf("stream: got %v; want FILE_UNREADABLE with status 0, caused by the reader's error", err)
		}
		_, err = caitlyn.FileFromPath(filepath.Join(t.TempDir(), "no-such-file.pdf"))
		if !errors.As(err, &e) || e.Code != "FILE_UNREADABLE" || e.Status != 0 || !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("path: got %v; want FILE_UNREADABLE with status 0, caused by fs.ErrNotExist", err)
		}
		if len(m.api(t)) != 0 {
			t.Fatalf("sent %v; want nothing", m.api(t))
		}
	}
	protocol["errors.item-has-no-file"] = func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"strayItem": "/hr/stray.pdf"})
		dir := t.TempDir()
		writeFile(t, dir, "annual-leave.md", []byte("Staff receive 20 days of annual leave."))
		_, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(within(t), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"})
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "INGESTION_ITEM_HAS_NO_FILE" || e.Status != 0 || !strings.Contains(err.Error(), "/hr/stray.pdf") {
			t.Fatalf("got %v; want INGESTION_ITEM_HAS_NO_FILE with status 0, naming /hr/stray.pdf", err)
		}
		if forms := m.matching(t, isForm); len(forms) != 0 {
			t.Fatalf("uploaded %d files; want none", len(forms))
		}
	}
}
