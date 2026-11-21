package conformance

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
)

// The 0.9 cases: files (PROTOCOL.md 14), upload targets (10) and kb.Ingestion.Sync (15).

// A leave policy in a few lines: what each file test sends.
var leavePolicy = []byte("Leave policy\n\nStaff receive 20 days of annual leave a year, accrued fortnightly.\n")

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return base64.StdEncoding.EncodeToString(s[:])
}

func shaURL(b []byte) string {
	s := sha256.Sum256(b)
	return base64.RawURLEncoding.EncodeToString(s[:])
}

// oneShot is a stream that can be read once: it hides any Seek the reader under it has.
type oneShot struct{ r io.Reader }

func (o *oneShot) Read(b []byte) (int, error) { return o.r.Read(b) }

// hook is an HTTP client that calls before for each request, then sends it.
type hook struct {
	before func(*http.Request)
	after  func(*http.Request, *http.Response)
	err    func(*http.Request, error)
}

func (h hook) Do(r *http.Request) (*http.Response, error) {
	if h.before != nil {
		h.before(r)
	}
	resp, err := http.DefaultClient.Do(r)
	if err == nil && h.after != nil {
		h.after(r, resp)
	}
	if err != nil && h.err != nil {
		h.err(r, err)
	}
	return resp, err
}

func jsonBody(t *testing.T, r logged) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(r.Body), &m); err != nil {
		t.Fatalf("%s %s: body %q: %v", r.Method, r.Path, r.Body, err)
	}
	return m
}

func isReserve(r logged) bool { return r.Method == "POST" && r.Path == "/v3/uploads" }
func isPut(r logged) bool     { return r.Method == "PUT" && strings.HasPrefix(r.Path, "/__s3/") }
func isForm(r logged) bool    { return r.Method == "POST" && r.Path == "/__s3/" }

func writeFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func sdkCode(err error) string {
	var e *caitlyn.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// kbPath is the knowledge base's own path: batches and their items are under it.
var kbPath = "/v3/knowledge-bases/" + kb

// policies is a folder of HR policies on disk, n files, and their contents by relative path.
func policies(t *testing.T, n int) (string, map[string][]byte) {
	t.Helper()
	dir := t.TempDir()
	files := map[string][]byte{}
	for i := 1; i <= n; i++ {
		name := fmt.Sprintf("policy-%02d.pdf", i)
		data := []byte(fmt.Sprintf("%%PDF-1.7\nHR policy %d: %s", i, leavePolicy))
		writeFile(t, dir, name, data)
		files[name] = data
	}
	return dir, files
}

// stampedFiles are n small, distinct files given directly (not from a folder).
func stampedFiles(n int) []caitlyn.LocalFile {
	out := make([]caitlyn.LocalFile, n)
	for i := range out {
		name := fmt.Sprintf("notice-%04d.md", i)
		out[i] = caitlyn.LocalFile{RelativePath: name, File: caitlyn.FileFromBytes(name, []byte(fmt.Sprintf("# Notice %d\n\nThe office closes at 5 pm.\n", i)))}
	}
	return out
}

func init() {
	for id, run := range filesCases {
		protocol[id] = run
	}
}

var filesCases = map[string]func(t *testing.T, m mock){
	"files.sources": func(t *testing.T, m mock) {
		c := client(t, m)
		p := writeFile(t, t.TempDir(), "leave-policy.md", leavePolicy)
		fromPath, err := caitlyn.FileFromPath(p)
		if err != nil {
			t.Fatal(err)
		}
		sources := []*caitlyn.UploadFile{
			fromPath,
			caitlyn.FileFromBytes("leave-policy.md", leavePolicy),
			caitlyn.FileFromReader("leave-policy.md", &oneShot{bytes.NewReader(leavePolicy)}),
		}
		for _, f := range sources {
			if _, err := c.Core.Uploads.Send(context.Background(), f, nil); err != nil {
				t.Fatal(err)
			}
		}
		reserves := m.matching(t, isReserve)
		if len(reserves) != 3 {
			t.Fatalf("%d reservations", len(reserves))
		}
		want := map[string]any{"fileName": "leave-policy.md", "contentType": "text/markdown", "byteSize": float64(len(leavePolicy)), "sha256": sha(leavePolicy)}
		for _, r := range reserves {
			if body := jsonBody(t, r); !reflect.DeepEqual(body, want) {
				t.Fatalf("reserved %v, want %v", body, want)
			}
		}
		for _, put := range m.matching(t, isPut) {
			if put.BodySHA256 != sha(leavePolicy) || put.BodyLength != int64(len(leavePolicy)) {
				t.Fatalf("sent %s (%d bytes)", put.BodySHA256, put.BodyLength)
			}
		}
	},

	"files.content-type": func(t *testing.T, m mock) {
		cases := map[string]string{
			"leave-policy.pdf":  "application/pdf",
			"leave-policy.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"leave-policy.md":   "text/markdown",
			"leave-policy.PDF":  "application/pdf",
			"leave-policy.xyz":  "application/octet-stream",
			"leave-policy":      "application/octet-stream",
		}
		for name, want := range cases {
			if got := caitlyn.FileFromBytes(name, leavePolicy).ContentType(); got != want {
				t.Fatalf("%s: %s, want %s", name, got, want)
			}
		}
		// Every extension in the table every SDK shares
		b, err := os.ReadFile(filepath.Join(root, "conformance", "cases", "content-types.json"))
		if err != nil {
			t.Fatal(err)
		}
		var shared struct {
			ContentTypes map[string]string `json:"contentTypes"`
		}
		if err := json.Unmarshal(b, &shared); err != nil {
			t.Fatal(err)
		}
		for ext, want := range shared.ContentTypes {
			if got := caitlyn.FileFromBytes("file."+ext, leavePolicy).ContentType(); got != want {
				t.Fatalf(".%s: %s, want %s", ext, got, want)
			}
		}
		given := caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy, caitlyn.WithContentType("text/plain"))
		if _, err := client(t, m).Core.Uploads.Send(context.Background(), given, nil); err != nil {
			t.Fatal(err)
		}
		if ct := jsonBody(t, m.matching(t, isReserve)[0])["contentType"]; ct != "text/plain" {
			t.Fatalf("sent %v, want the caller's text/plain", ct)
		}
	},

	"files.spool": func(t *testing.T, m mock) {
		tmp := t.TempDir()
		t.Setenv("TMPDIR", tmp)
		data := bytes.Repeat([]byte("Annual leave accrues fortnightly. "), (9<<20)/34+1) // over 8 MiB
		var seen []os.FileInfo
		c := client(t, m, caitlyn.WithHTTPClient(hook{before: func(r *http.Request) {
			if r.URL.Path == "/v3/uploads" { // while the call is under way: the copy is on disk, readable by its owner only
				entries, _ := os.ReadDir(tmp)
				for _, e := range entries {
					fi, _ := e.Info()
					seen = append(seen, fi)
				}
			}
		}}))
		if _, err := c.Core.Uploads.Send(context.Background(), caitlyn.FileFromReader("leave-policies.txt", &oneShot{bytes.NewReader(data)}), nil); err != nil {
			t.Fatal(err)
		}
		if len(seen) != 1 || seen[0].Mode().Perm() != 0o600 || seen[0].Size() != int64(len(data)) {
			t.Fatalf("spool files during the call: %v", seen)
		}
		if left, _ := os.ReadDir(tmp); len(left) != 0 {
			t.Fatalf("left on disk after the call: %v", left)
		}
		puts := m.matching(t, isPut)
		if len(puts) != 1 || puts[0].BodySHA256 != sha(data) || puts[0].BodyLength != int64(len(data)) {
			t.Fatalf("sent %+v", puts)
		}
		// A stream under 8 MiB stays in memory: nothing is written to disk.
		seen = nil
		if _, err := c.Core.Uploads.Send(context.Background(), caitlyn.FileFromReader("leave-policy.md", &oneShot{bytes.NewReader(leavePolicy)}), nil); err != nil {
			t.Fatal(err)
		}
		if len(seen) != 0 {
			t.Fatalf("a small stream was spooled to disk: %v", seen)
		}
	},

	"files.too-large": func(t *testing.T, m mock) {
		c := client(t, m)
		p := filepath.Join(t.TempDir(), "archive.mp4")
		f, err := os.Create(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(2<<30 + 1); err != nil { // sparse: nothing is written
			t.Fatal(err)
		}
		f.Close()
		big, err := caitlyn.FileFromPath(p)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Core.Uploads.Send(context.Background(), big, nil); sdkCode(err) != "FILE_TOO_LARGE" {
			t.Fatalf("path: %v", err)
		}
		stream := caitlyn.FileFromReader("archive.mp4", &oneShot{bytes.NewReader(nil)}, caitlyn.WithSize(2<<30+1))
		if _, err := c.KnowledgeBase(kb).Documents.Create(context.Background(), stream, &caitlyn.CreateDocumentInput{Folder: "/hr/"}); sdkCode(err) != "FILE_TOO_LARGE" {
			t.Fatalf("stream: %v", err)
		}
		if reqs := m.requests(t); len(reqs) != 0 {
			t.Fatalf("sent %d requests", len(reqs))
		}
	},

	"files.changed": func(t *testing.T, m mock) {
		for _, change := range []string{"size", "modification time"} {
			fresh(t)
			p := writeFile(t, t.TempDir(), "leave-policy.md", leavePolicy)
			f, err := caitlyn.FileFromPath(p)
			if err != nil {
				t.Fatal(err)
			}
			c := client(t, m, caitlyn.WithHTTPClient(hook{before: func(r *http.Request) {
				if r.URL.Path != "/v3/uploads" {
					return
				}
				// Between hashing and sending.
				if change == "size" {
					os.WriteFile(p, append(leavePolicy, "Amended."...), 0o600)
				} else {
					later := time.Now().Add(time.Hour)
					os.Chtimes(p, later, later)
				}
			}}))
			if _, err := c.Core.Uploads.Send(context.Background(), f, nil); sdkCode(err) != "FILE_CHANGED" {
				t.Fatalf("%s changed: %v", change, err)
			}
			if puts := m.matching(t, isPut); len(puts) != 0 {
				t.Fatalf("%s changed: the bytes were sent", change)
			}
		}
	},

	"files.put-retry": func(t *testing.T, m mock) {
		m.faults(t, status("PutUpload", fault(503, 0)))
		if _, err := client(t, m).Core.Uploads.Send(context.Background(), caitlyn.FileFromBytes("leave-policy.md", leavePolicy), nil); err != nil {
			t.Fatal(err)
		}
		puts := m.matching(t, isPut)
		if len(puts) != 2 || puts[0].Path != puts[1].Path || puts[0].BodySHA256 != sha(leavePolicy) || puts[1].BodySHA256 != sha(leavePolicy) {
			t.Fatalf("puts %+v", puts)
		}
		if !reflect.DeepEqual(puts[0].Headers, puts[1].Headers) {
			t.Fatalf("headers differ: %v and %v", puts[0].Headers, puts[1].Headers)
		}
		// Bytes the upload URL keeps refusing are UPLOAD_PUT_FAILED.
		fresh(t)
		m.faults(t, status("PutUpload", fault(503, 0), fault(503, 0), fault(503, 0)))
		if _, err := client(t, m).Core.Uploads.Send(context.Background(), caitlyn.FileFromBytes("leave-policy.md", leavePolicy), nil); sdkCode(err) != "UPLOAD_PUT_FAILED" {
			t.Fatalf("got %v", err)
		}
	},

	"upload-target.top-level": func(t *testing.T, m mock) {
		var required map[string]string
		c := client(t, m, caitlyn.WithHTTPClient(hook{after: func(r *http.Request, resp *http.Response) {
			if r.URL.Path == "/v3/uploads" {
				b, _ := io.ReadAll(resp.Body)
				resp.Body = io.NopCloser(bytes.NewReader(b))
				var up struct {
					RequiredHeaders map[string]string `json:"requiredHeaders"`
				}
				json.Unmarshal(b, &up)
				required = up.RequiredHeaders
			}
		}}))
		in := &caitlyn.CreateDocumentInput{Folder: "/hr/"}
		doc, err := c.KnowledgeBase(kb).Documents.Create(context.Background(), caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy), in)
		if err != nil {
			t.Fatal(err)
		}
		// The new document's scope, carrying the response: its calls fill the new document's identifier.
		if doc.ID() == "" || doc.Result.Operation.ID == "" || doc.DocumentScope == nil {
			t.Fatalf("result %+v", doc)
		}
		if !reflect.DeepEqual(*in, caitlyn.CreateDocumentInput{Folder: "/hr/"}) {
			t.Fatal("the caller's input was changed")
		}
		reqs := m.requests(t)
		if len(reqs) != 3 || !isReserve(reqs[0]) || !isPut(reqs[1]) || reqs[2].Path != "/v3/knowledge-bases/"+kb+"/documents" {
			t.Fatalf("requests %+v", reqs)
		}
		put := reqs[1]
		for k, v := range required {
			if put.Headers[strings.ToLower(k)] != v {
				t.Fatalf("PUT header %s: %q, want %q", k, put.Headers[strings.ToLower(k)], v)
			}
		}
		for _, h := range put.HeaderNames {
			h = strings.ToLower(h)
			if _, ok := required[h]; !ok && !slices.Contains([]string{"host", "content-length", "accept-encoding", "connection"}, h) {
				if _, ok := requiredLower(required)[h]; !ok {
					t.Fatalf("PUT sent %s, which requiredHeaders does not name", h)
				}
			}
		}
		uploadID := strings.TrimPrefix(put.Path, "/__s3/")
		if body := jsonBody(t, reqs[2]); body["uploadId"] != uploadID || body["folder"] != "/hr/" {
			t.Fatalf("CreateDocument %v, upload %s", body, uploadID)
		}
		if got, err := doc.Get(context.Background()); err != nil || got.ID != doc.ID() {
			t.Fatalf("the new scope read %+v, %v", got, err)
		}
		// kb.Document(id).Replace(file) adds a version the same way, and its Wait follows the version's ingestion.
		fresh(t)
		const document = "doc-0001" // one of the mock's indexed documents
		edition := []byte("%PDF-1.7\nLeave policy, the 2027 edition: 25 days of annual leave.\n")
		v, err := c.KnowledgeBase(kb).Document(document).Replace(context.Background(), caitlyn.FileFromBytes("policy-1.pdf", edition),
			&caitlyn.CreateDocumentVersionInput{Note: caitlyn.Ptr("The 2027 edition")})
		if err != nil {
			t.Fatal(err)
		}
		if v.Result.Result != caitlyn.VersionResultCreated || v.Result.Version.Number != 2 || v.Result.Operation == nil || v.Result.Operation.ID == "" {
			t.Fatalf("result %+v", v)
		}
		reqs = m.requests(t)
		if len(reqs) != 3 || !isReserve(reqs[0]) || !isPut(reqs[1]) || reqs[2].Path != kbPath+"/documents/"+document+"/versions" {
			t.Fatalf("requests %+v", reqs)
		}
		if body := jsonBody(t, reqs[2]); len(body) != 2 || body["uploadId"] != strings.TrimPrefix(reqs[1].Path, "/__s3/") || body["note"] != "The 2027 edition" {
			t.Fatalf("CreateDocumentVersion %v", body)
		}
		indexed, err := v.Wait(context.Background())
		if err != nil || indexed.Version == nil || *indexed.Version != 2 || indexed.Status != caitlyn.DocumentStatusIndexed {
			t.Fatalf("waited for %+v, %v", indexed, err)
		}
	},

	"upload-target.nested": func(t *testing.T, m mock) {
		c := client(t, m)
		png := []byte("\x89PNG\r\n\x1a\n a small round picture of a leaf")
		in := &caitlyn.CreateAgentInput{Name: "Leave assistant", Avatar: &caitlyn.AgentAvatarInput{
			Mark: &caitlyn.AgentMarkInput{PictureFile: caitlyn.FileFromBytes("leaf.png", png)}}}
		if _, err := c.Agents.Create(context.Background(), in); err != nil {
			t.Fatal(err)
		}
		if in.Avatar.Mark.PictureUploadID != nil || in.Avatar.Mark.PictureFile == nil {
			t.Fatal("the caller's input was changed")
		}
		reserve := jsonBody(t, m.matching(t, isReserve)[0])
		if !reflect.DeepEqual(reserve["purpose"], map[string]any{"agentAvatar": true}) || reserve["contentType"] != "image/png" {
			t.Fatalf("reserved %v", reserve)
		}
		uploadID := strings.TrimPrefix(m.matching(t, isPut)[0].Path, "/__s3/")
		create := jsonBody(t, m.matching(t, func(r logged) bool { return r.Method == "POST" && r.Path == "/v3/agents" })[0])
		want := map[string]any{"name": "Leave assistant", "avatar": map[string]any{"mark": map[string]any{"pictureUploadId": uploadID}}}
		if !reflect.DeepEqual(create, want) {
			t.Fatalf("CreateAgent %v, want %v", create, want)
		}
	},

	"sync.flow": func(t *testing.T, m mock) {
		var startBody []byte
		c := client(t, m, caitlyn.WithHTTPClient(hook{after: func(r *http.Request, resp *http.Response) {
			if strings.HasSuffix(r.URL.Path, "/start") {
				startBody, _ = io.ReadAll(resp.Body)
				resp.Body = io.NopCloser(bytes.NewReader(startBody))
			}
		}}))
		dir, files := policies(t, 3)
		writeFile(t, dir, "drafts/unfinished.pdf", []byte("not yet"))
		writeFile(t, dir, ".caitlynignore", []byte("# drafts stay local\ndrafts/\n"))
		// With a Confirm, so the plan is priced (sync.no-confirm-no-estimate: without one it is not).
		report, err := c.KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
			Confirm: func(context.Context, *caitlyn.SyncPlan) (bool, error) { return true, nil }})
		if err != nil {
			t.Fatal(err)
		}
		// Created to start by hand, keyed by relative path.
		create := jsonBody(t, m.matching(t, func(r logged) bool { return r.Method == "POST" && r.Path == kbPath+"/ingestion-batches" })[0])
		if create["start"] != "manual" || create["items"].([]any)[0].(map[string]any)["externalId"] != "policy-01.pdf" {
			t.Fatalf("CreateIngestionBatch %v", create)
		}
		// The order of the steps.
		var steps []string
		for _, r := range m.requests(t) {
			step := r.Method + " " + r.Path
			if strings.Contains(r.Query, "awaiting_upload") {
				step += "?awaiting_upload"
			}
			if len(steps) == 0 || steps[len(steps)-1] != step {
				steps = append(steps, step)
			}
		}
		b := kbPath + "/ingestion-batches/" + report.Batch.ID
		want := []string{"POST " + kbPath + "/ingestion-batches", "GET " + kbPath + "/events", "GET " + b, "GET " + b + "/items",
			"POST " + kbPath + "/ingestions:estimate", "POST " + b + "/start", "GET " + b + "/items?awaiting_upload", "POST /__s3/",
			"POST " + b + "/complete-uploads", "GET " + kbPath + "/events", "GET " + b, "GET " + b + "/items"}
		if !isSubsequence(want, steps) || steps[0] != want[0] {
			t.Fatalf("steps %v, want in order %v", steps, want)
		}
		// Each form POST: the policy's fields in order, then key, Content-Type, the checksum fields and the file.
		var start struct {
			UploadPolicy json.RawMessage `json:"uploadPolicy"`
		}
		json.Unmarshal(startBody, &start)
		var policyFields []string
		dec := json.NewDecoder(bytes.NewReader(start.UploadPolicy))
		var policy map[string]json.RawMessage
		dec.Decode(&policy)
		fdec := json.NewDecoder(bytes.NewReader(policy["formFields"]))
		fdec.Token()
		for fdec.More() {
			k, _ := fdec.Token()
			var v string
			fdec.Decode(&v)
			// The policy's own `key` is left out: the item's is sent after the policy's fields (PROTOCOL.md 15).
			if k.(string) != "key" {
				policyFields = append(policyFields, k.(string))
			}
		}
		if len(policyFields) == 0 || policyFields[0] != "bucket" {
			t.Fatalf("policy fields %v: the mock's policy is shaped as createPresignedPost's", policyFields)
		}
		forms := m.matching(t, isForm)
		if len(forms) != 3 {
			t.Fatalf("%d form POSTs for 3 files", len(forms))
		}
		for _, f := range forms {
			var names []string
			parts := map[string]formPart{}
			for _, p := range f.Form {
				names = append(names, p.Name)
				parts[p.Name] = p
			}
			wantNames := append(append([]string(nil), policyFields...), "key", "Content-Type", "x-amz-checksum-algorithm", "x-amz-checksum-sha256", "file")
			if !reflect.DeepEqual(names, wantNames) {
				t.Fatalf("form fields %v, want %v", names, wantNames)
			}
			file := parts["file"]
			var data []byte
			for _, d := range files {
				if sha(d) == file.SHA256 {
					data = d
				}
			}
			if data == nil || parts["x-amz-checksum-algorithm"].Value != "SHA256" || parts["x-amz-checksum-sha256"].Value != sha(data) ||
				!strings.Contains(parts["key"].Value, shaURL(data)) || parts["Content-Type"].Value != "application/pdf" {
				t.Fatalf("form %+v", f.Form)
			}
		}
		if len(report.Items) != 3 {
			t.Fatalf("report %d items", len(report.Items))
		}
		for _, it := range report.Items {
			if it.Status != caitlyn.IngestionItemStatusIndexed || it.DocumentID == nil || !strings.HasPrefix(deref(it.Path), "/hr/policy-") {
				t.Fatalf("item %+v", it)
			}
		}
	},

	"sync.many-items": func(t *testing.T, m mock) {
		// The mock does not log bodies this large, so the test keeps its own copy of each one.
		var mu sync.Mutex
		bodies := map[string][]map[string]any{}
		c := client(t, m, caitlyn.WithHTTPClient(hook{before: func(r *http.Request) {
			if r.Method != "POST" && r.Method != "PATCH" || r.GetBody == nil || !strings.HasPrefix(r.URL.Path, kbPath+"/ingestion-batches") {
				return
			}
			rc, _ := r.GetBody()
			var body map[string]any
			json.NewDecoder(rc).Decode(&body)
			key := r.Method + " " + r.URL.Path
			if strings.HasSuffix(r.URL.Path, "/items:batch-create") {
				key = "batch-create"
			} else if r.Method == "PATCH" {
				key = "update"
			}
			mu.Lock()
			bodies[key] = append(bodies[key], body)
			mu.Unlock()
		}}))
		// Confirm stops after the plan: this case is about creating the batch, not uploading 10,050 files.
		_, err := c.KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Files(stampedFiles(10050)), &caitlyn.SyncOptions{Folder: "/notices/",
			Confirm: func(context.Context, *caitlyn.SyncPlan) (bool, error) { return false, nil }})
		if sdkCode(err) != "CANCELLED" {
			t.Fatal(err)
		}
		create := bodies["POST "+kbPath+"/ingestion-batches"][0]
		if len(create["items"].([]any)) != 10000 || create["awaitMoreItems"] != true || create["start"] != "manual" {
			t.Fatalf("create: %d items, awaitMoreItems %v", len(create["items"].([]any)), create["awaitMoreItems"])
		}
		var groups []int
		var last []any
		for _, b := range bodies["batch-create"] {
			groups = append(groups, len(b["items"].([]any)))
			last = append(last, b["last"])
		}
		// The rest through core.ingestion.addItems, the last call with last: true; no UpdateIngestionBatch.
		if !reflect.DeepEqual(groups, []int{50}) || !reflect.DeepEqual(last, []any{true}) || len(bodies["update"]) != 0 {
			t.Fatalf("batch-create groups %v, last %v, %d updates", groups, last, len(bodies["update"]))
		}
	},

	"sync.concurrency": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"uploadDelayMs": 150})
		dir, _ := policies(t, 14)
		if _, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"}); err != nil {
			t.Fatal(err)
		}
		if n := m.uploads(t).MaxInFlight; n != 6 {
			t.Fatalf("at most %d uploads at once, want 6", n)
		}
	},

	"sync.complete-groups": func(t *testing.T, m mock) {
		if _, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Files(stampedFiles(250)), &caitlyn.SyncOptions{Folder: "/notices/"}); err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, r := range m.matching(t, pathHasSuffix("/complete-uploads")) {
			ids := jsonBody(t, r)["itemIds"].([]any)
			if len(ids) == 0 || len(ids) > 100 {
				t.Fatalf("a call named %d items", len(ids))
			}
			for _, id := range ids {
				seen[id.(string)] = true
			}
		}
		if len(seen) != 250 {
			t.Fatalf("completed %d items of 250", len(seen))
		}
	},

	"sync.policy-renewal": func(t *testing.T, m mock) {
		// Start's policy lasts a second, so its renewal margin is half a second; each file takes a second to arrive, one at
		// a time. The first goes with Start's policy; it is renewed before the second goes.
		m.faults(t, map[string]any{"policySeconds": 1, "uploadDelayMs": 1000})
		dir, _ := policies(t, 2)
		c := client(t, m)
		if _, err := c.KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/", Concurrency: 1}); err != nil {
			t.Fatal(err)
		}
		if order := uploadOrder(m.requests(t)); order != "upload policy upload" {
			t.Fatalf("POSTs %q; want the renewal between the uploads", order)
		}
		// A 403 saying the policy expired: renewed once, and that file sent again.
		fresh(t)
		m.faults(t, map[string]any{"startPolicyExpired": true})
		if _, err := c.KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/", Concurrency: 1}); err != nil {
			t.Fatal(err)
		}
		if n := len(m.matching(t, pathHasSuffix("/upload-policies"))); n != 1 {
			t.Fatalf("renewed %d times", n)
		}
		if forms := m.matching(t, isForm); len(forms) != 3 || forms[0].Form[len(forms[0].Form)-1].SHA256 != forms[1].Form[len(forms[1].Form)-1].SHA256 {
			t.Fatalf("%d form POSTs, want the refused file again and then the other", len(forms))
		}
		if objects := m.uploads(t).Objects; len(objects) != 2 {
			t.Fatalf("%d objects stored", len(objects))
		}
	},

	"sync.checksum-mismatch": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"checksumMismatch": map[string]any{"/hr/policy-01.pdf": 1}})
		dir, files := policies(t, 2)
		report, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		sent := 0
		for _, f := range m.matching(t, isForm) {
			if f.Form[len(f.Form)-1].SHA256 == sha(files["policy-01.pdf"]) {
				sent++
			}
		}
		if sent != 2 || len(m.matching(t, pathHasSuffix("/complete-uploads"))) < 2 {
			t.Fatalf("the mismatched file was sent %d times", sent)
		}
		for _, it := range report.Items {
			if it.Status != caitlyn.IngestionItemStatusIndexed {
				t.Fatalf("item %+v", it)
			}
		}
	},

	"sync.plan-failed": func(t *testing.T, m mock) {
		// A plan that ends the batch failed returns the batch's own failure (code and message); nothing is started.
		cases := []struct {
			faults map[string]any
			code   string
			says   string
		}{
			{map[string]any{"planConflicts": map[string]any{"/hr/policy-01.pdf": "duplicate_path"}}, "conflict_policy_fail", "policy rule is `fail`"},
			{map[string]any{"planFails": true}, "planning_failed", "Planning could not finish"},
		}
		for _, c := range cases {
			m.post(t, "/__mock/reset", nil)
			m.faults(t, c.faults)
			dir, _ := policies(t, 2)
			fail := caitlyn.ConflictRuleFail
			_, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
				Policy: &caitlyn.IngestionPolicy{OnConflict: &caitlyn.ConflictRules{Default: &fail}}})
			var e *caitlyn.Error
			if !errors.As(err, &e) || e.Code != c.code || !strings.Contains(err.Error(), c.says) {
				t.Fatalf("got %v, want %s: %s", err, c.code, c.says)
			}
			if len(m.matching(t, pathHasSuffix("/start"))) != 0 {
				t.Fatal("a failed batch was started")
			}
		}
	},

	"sync.resolve": func(t *testing.T, m mock) {
		conflicts := map[string]any{"/hr/policy-01.pdf": "duplicate_path", "/hr/policy-02.pdf": "duplicate_path", "/hr/policy-03.pdf": "duplicate_path"}
		answers := map[string]caitlyn.IngestionItemResolution{"/hr/policy-01.pdf": caitlyn.IngestionItemResolutionAdd,
			"/hr/policy-02.pdf": caitlyn.IngestionItemResolutionNewVersion, "/hr/policy-03.pdf": caitlyn.IngestionItemResolutionOverwrite}
		m.faults(t, map[string]any{"planConflicts": conflicts})
		dir, _ := policies(t, 3)
		c := client(t, m)
		_, err := c.KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
			Resolve: func(_ context.Context, it caitlyn.IngestionBatchItem) (caitlyn.IngestionItemResolution, error) {
				return answers[deref(it.Path)], nil
			}})
		if err != nil {
			t.Fatal(err)
		}
		patches := m.matching(t, func(r logged) bool { return r.Method == "PATCH" && strings.Contains(r.Path, "/items/") })
		var got []string
		for _, p := range patches {
			if p.Headers["if-match"] == "" {
				t.Fatal("a resolution without If-Match")
			}
			got = append(got, jsonBody(t, p)["resolution"].(string))
		}
		slices.Sort(got)
		if !reflect.DeepEqual(got, []string{"add", "new_version", "overwrite"}) {
			t.Fatalf("resolutions %v", got)
		}
		// With no resolver: INGESTION_BATCH_UNRESOLVED, and the batch is left planned.
		fresh(t)
		m.faults(t, map[string]any{"planConflicts": conflicts})
		_, err = c.KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"})
		if sdkCode(err) != "INGESTION_BATCH_UNRESOLVED" {
			t.Fatalf("got %v", err)
		}
		if starts := m.matching(t, pathHasSuffix("/start")); len(starts) != 0 {
			t.Fatal("the batch was started")
		}
		for b, err := range c.KnowledgeBase(kb).Ingestion.Batches.List(context.Background(), nil) {
			if err != nil {
				t.Fatal(err)
			}
			if b.Status != caitlyn.IngestionBatchStatusPlanned {
				t.Fatalf("batch %s is %s", b.ID, b.Status)
			}
		}
	},

	"sync.confirm": func(t *testing.T, m mock) {
		dir, _ := policies(t, 2)
		var plan *caitlyn.SyncPlan
		_, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
			Confirm: func(_ context.Context, p *caitlyn.SyncPlan) (bool, error) { plan = p; return false, nil }})
		// Declined: CANCELLED, an error the SDK raises itself, with the report; not the context's error.
		var declined *caitlyn.SyncDeclinedError
		var e *caitlyn.Error
		if !errors.As(err, &declined) || !errors.As(err, &e) || e.Code != "CANCELLED" || e.Status != 0 || errors.Is(err, context.Canceled) {
			t.Fatalf("got %T %v, want CANCELLED that is not context.Canceled", err, err)
		}
		if declined.Report == nil || len(declined.Report.Items) != 2 || declined.Report.Batch == nil || declined.Report.Batch.Status != caitlyn.IngestionBatchStatusCancelled {
			t.Fatalf("report %+v", declined.Report)
		}
		if plan == nil || plan.Batch.Status != caitlyn.IngestionBatchStatusPlanned || len(plan.Items) != 2 || plan.Items[0].Outcome == nil ||
			plan.Estimate == nil || plan.Estimate.Documents != 2 {
			t.Fatalf("plan %+v", plan)
		}
		if len(m.matching(t, pathHasSuffix("/cancel"))) != 1 || len(m.matching(t, pathHasSuffix("/start"))) != 0 || len(m.matching(t, isForm)) != 0 {
			t.Fatal("false did not cancel the batch and end the call")
		}
		b, err := client(t, m).KnowledgeBase(kb).Ingestion.Batch(plan.Batch.ID).Get(context.Background())
		if err != nil || b.Status != caitlyn.IngestionBatchStatusCancelled {
			t.Fatalf("batch %+v, %v", b, err)
		}
	},

	"sync.remove-missing": func(t *testing.T, m mock) {
		c := client(t, m)
		var existing []string
		for d, err := range c.KnowledgeBase(kb).Documents.List(context.Background(), &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Deep: caitlyn.Ptr(true)}) {
			if err != nil {
				t.Fatal(err)
			}
			existing = append(existing, d.Folder+d.Name)
		}
		if len(existing) < 2 {
			t.Fatalf("the mock has %d documents under /policies/", len(existing))
		}
		dir := t.TempDir()
		kept := strings.TrimPrefix(existing[0], "/policies/")
		writeFile(t, dir, kept, leavePolicy)
		fresh(t)
		if _, err := c.KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/policies/", RemoveMissing: true}); err != nil {
			t.Fatal(err)
		}
		create := jsonBody(t, m.matching(t, func(r logged) bool { return r.Method == "POST" && r.Path == kbPath+"/ingestion-batches" })[0])
		var removed []string
		for _, raw := range create["items"].([]any) {
			it := raw.(map[string]any)
			if it["action"] == "remove" {
				removed = append(removed, it["path"].(string))
			} else if it["path"] != existing[0] {
				t.Fatalf("ingest item %v", it)
			}
		}
		slices.Sort(removed)
		want := slices.Clone(existing[1:])
		slices.Sort(want)
		if !reflect.DeepEqual(removed, want) {
			t.Fatalf("removed %v, want %v", removed, want)
		}
	},

	"sync.progress": func(t *testing.T, m mock) {
		dir, files := policies(t, 3)
		var total int64
		for _, d := range files {
			total += int64(len(d))
		}
		var phases []string
		var lastUpload caitlyn.IngestionProgress
		var items []string
		_, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
			OnProgress: func(p caitlyn.IngestionProgress) {
				if len(phases) == 0 || phases[len(phases)-1] != string(p.Phase) {
					phases = append(phases, string(p.Phase))
				}
				if p.Phase == caitlyn.SyncPhaseUpload {
					lastUpload = p
				}
			},
			OnItem: func(it caitlyn.IngestionBatchItem) { items = append(items, it.ID) },
		})
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"checksum", "planning", "planned", "upload", "queued", "processing", "succeeded"}
		if !reflect.DeepEqual(phases, want) {
			t.Fatalf("phases %v, want %v", phases, want)
		}
		if lastUpload.Done != 3 || lastUpload.Total != 3 || lastUpload.BytesSent != total || lastUpload.BytesTotal != total {
			t.Fatalf("last upload report %+v", lastUpload)
		}
		if slices.Sort(items); len(slices.Compact(items)) != 3 {
			t.Fatalf("onItem for %v", items)
		}
	},

	"sync.cancel": func(t *testing.T, m mock) {
		// The first upload is answered; every later one is held until the client lets go of it, so the uploads in
		// flight are still in flight when the cancel lands.
		m.faults(t, map[string]any{"holdUploadsAfter": 1})
		dir, _ := policies(t, 12)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		var mu sync.Mutex
		var finished []string
		aborted := 0 // form POSTs this client gave up on in flight
		// Cancel once the first upload has finished and a later one has been sent (and so is held in flight).
		sent, done := 0, 0
		cancelWhenReady := func() {
			if sent >= 2 && done >= 1 {
				cancel()
			}
		}
		c := client(t, m, caitlyn.WithHTTPClient(hook{before: func(r *http.Request) {
			if r.URL.Path == "/__s3/" {
				mu.Lock()
				sent++
				cancelWhenReady()
				mu.Unlock()
			}
		}, err: func(r *http.Request, err error) {
			if r.URL.Path == "/__s3/" && errors.Is(err, context.Canceled) {
				mu.Lock()
				aborted++
				mu.Unlock()
			}
		}}))
		_, err := c.KnowledgeBase(kb).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/", CancelIngestion: true,
			OnProgress: func(p caitlyn.IngestionProgress) {
				if p.Phase == caitlyn.SyncPhaseUpload {
					mu.Lock()
					done = p.Done
					cancelWhenReady()
					mu.Unlock()
				}
			},
			OnItem: func(it caitlyn.IngestionBatchItem) { mu.Lock(); finished = append(finished, it.ID); mu.Unlock() },
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v, want context.Canceled", err)
		}
		// Uploads in flight were aborted, and no new ones began.
		mu.Lock()
		defer mu.Unlock()
		if aborted == 0 {
			t.Fatal("no upload was aborted in flight")
		}
		if stored := len(m.uploads(t).Objects); stored >= 12 {
			t.Fatalf("all %d files were stored", stored)
		}
		cancels := m.matching(t, pathHasSuffix("/cancel"))
		if len(cancels) != 1 || jsonBody(t, cancels[0])["stopRunning"] != true {
			t.Fatalf("cancels %+v", cancels)
		}
		// An item reaches onItem only once its upload is accepted.
		accepted := map[string]bool{}
		for _, r := range m.matching(t, pathHasSuffix("/complete-uploads")) {
			for _, id := range jsonBody(t, r)["itemIds"].([]any) {
				accepted[id.(string)] = true
			}
		}
		for _, id := range finished {
			if !accepted[id] {
				t.Fatalf("onItem for %s, which was never completed", id)
			}
		}
	},
}

func requiredLower(h map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range h {
		out[strings.ToLower(k)] = v
	}
	return out
}

// isSubsequence reports whether want appears in got in order (other entries may come between).
func isSubsequence(want, got []string) bool {
	i := 0
	for _, g := range got {
		if i < len(want) && g == want[i] {
			i++
		}
	}
	return i == len(want)
}

func init() {
	protocol["sync.cancelled-item"] = func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"cancelItems": map[string]any{"/hr/policy-02.pdf": true}})
		dir, files := policies(t, 3)
		var reported []string
		var lastDone, lastTotal int
		report, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
			OnItem: func(it caitlyn.IngestionBatchItem) {
				reported = append(reported, deref(it.Path)+" "+string(it.Status)+" "+deref(it.FailureCode))
			},
			OnProgress: func(p caitlyn.IngestionProgress) {
				if p.Phase == "succeeded" {
					lastDone, lastTotal = p.Done, p.Total
				}
			}})
		if err != nil {
			t.Fatal(err)
		}
		if report.Batch.Status != caitlyn.IngestionBatchStatusSucceeded || lastDone != 3 || lastTotal != 3 {
			t.Fatalf("batch %s, done %d of %d", report.Batch.Status, lastDone, lastTotal)
		}
		cancelled := 0
		for _, r := range reported {
			if r == "/hr/policy-02.pdf cancelled " {
				cancelled++
			} else if strings.HasPrefix(r, "/hr/policy-02.pdf") && !strings.HasPrefix(r, "/hr/policy-02.pdf ingesting") {
				t.Fatalf("the cancelled item reported as %q", r)
			}
		}
		for _, it := range report.Items {
			if deref(it.Path) == "/hr/policy-02.pdf" && (it.Status != caitlyn.IngestionItemStatusCancelled || it.FailureCode != nil) {
				t.Fatalf("in the report: %+v", it)
			}
		}
		// Uploaded once, never again.
		sent := 0
		for _, f := range m.matching(t, isForm) {
			if f.Form[len(f.Form)-1].SHA256 == sha(files["policy-02.pdf"]) {
				sent++
			}
		}
		if sent > 1 || cancelled > 1 {
			t.Fatalf("sent %d times, reported cancelled %d times (%v)", sent, cancelled, reported)
		}
	}
}

func init() {
	protocol["sync.on-item-once"] = func(t *testing.T, m mock) {
		final := map[caitlyn.IngestionItemStatus]bool{"indexed": true, "skipped": true, "moved": true, "updated": true, "removed": true, "cancelled": true, "failed": true}
		// One upload fails after its retries; the others are accepted, and reported only once indexed.
		m.faults(t, map[string]any{"failUploads": map[string]any{"/hr/policy-02.pdf": true}})
		dir, _ := policies(t, 3)
		var mu sync.Mutex
		var reported []caitlyn.IngestionBatchItem
		onItem := func(it caitlyn.IngestionBatchItem) {
			mu.Lock()
			reported = append(reported, it)
			mu.Unlock()
		}
		if _, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/", OnItem: onItem}); err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, it := range reported {
			if seen[it.ID] || !final[it.Status] {
				t.Fatalf("OnItem %s at %s (twice: %v)", deref(it.Path), it.Status, seen[it.ID])
			}
			seen[it.ID] = true
		}
		if len(reported) != 3 || deref(reported[0].Path) != "/hr/policy-02.pdf" || deref(reported[0].FailureCode) != "UPLOAD_FAILED" {
			t.Fatalf("reported %d items; want the failed upload first, at once, then the indexed two", len(reported))
		}
		// Cancelled during the uploads: only items already final were reported, and nothing after Sync returned.
		m = fresh(t)
		m.faults(t, map[string]any{"uploadDelayMs": 300})
		dir, _ = policies(t, 8)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		reported = nil
		_, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/", OnItem: onItem,
			OnProgress: func(p caitlyn.IngestionProgress) {
				if p.Phase == caitlyn.SyncPhaseUpload && p.Done == 1 {
					cancel()
				}
			}})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
		mu.Lock()
		atReturn := len(reported)
		for _, it := range reported {
			if !final[it.Status] {
				t.Fatalf("OnItem %s at %s before the cancellation", deref(it.Path), it.Status)
			}
		}
		mu.Unlock()
		time.Sleep(50 * time.Millisecond) // a call after Sync returned would land now
		mu.Lock()
		defer mu.Unlock()
		if len(reported) != atReturn {
			t.Fatalf("OnItem called %d times after Sync returned", len(reported)-atReturn)
		}
	}
}

func init() {
	protocol["sync.cancel-report"] = func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"uploadDelayMs": 300})
		dir, _ := policies(t, 8)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		// Cancelled once the first uploads are accepted, while the others are still to send.
		c := client(t, m, caitlyn.WithHTTPClient(hook{after: func(r *http.Request, _ *http.Response) {
			if strings.HasSuffix(r.URL.Path, "/complete-uploads") {
				cancel()
			}
		}}))
		_, err := c.KnowledgeBase(kb).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/", Concurrency: 2})
		var cancelled *caitlyn.SyncCancelledError
		if !errors.Is(err, context.Canceled) || !errors.As(err, &cancelled) {
			t.Fatalf("got %T %v; want a *SyncCancelledError that is context.Canceled", err, err)
		}
		var declined *caitlyn.SyncDeclinedError
		if errors.As(err, &declined) {
			t.Fatal("a cancelled context is not a declined Confirm")
		}
		// Every item with its last status, accepted ones not yet final included, and the batch's counts.
		rep := cancelled.Report
		if rep == nil || rep.Batch == nil || rep.Batch.Counts == nil || len(rep.Items) != 8 {
			t.Fatalf("report %+v", rep)
		}
		statuses := map[caitlyn.IngestionItemStatus]int{}
		for _, it := range rep.Items {
			statuses[it.Status]++
		}
		if statuses[caitlyn.IngestionItemStatusIngesting]+statuses[caitlyn.IngestionItemStatusIndexed] == 0 || statuses[caitlyn.IngestionItemStatusAwaitingUpload] == 0 {
			t.Fatalf("statuses %v; want the accepted uploads and those not yet sent", statuses)
		}
	}
}

func init() {
	protocol["sync.report-shape"] = func(t *testing.T, m mock) {
		// The same two members on every report: Batch, as reading the batch gives it, and Items, as listing them does.
		var _ *caitlyn.IngestionBatch = (&caitlyn.SyncReport{}).Batch
		var _ []caitlyn.IngestionBatchItem = (&caitlyn.SyncReport{}).Items
		var _ *caitlyn.SyncReport = (&caitlyn.SyncCancelledError{}).Report // a cancellation's report has the same shape
		var _ *caitlyn.SyncReport = (&caitlyn.SyncDeclinedError{}).Report  // and a declined confirm's
		if n := reflect.TypeOf(caitlyn.SyncReport{}).NumField(); n != 2 {
			t.Fatalf("SyncReport has %d fields, want Batch and Items", n)
		}
		dir, _ := policies(t, 2)
		rep, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		if rep.Batch == nil || rep.Batch.Status != caitlyn.IngestionBatchStatusSucceeded || rep.Batch.Counts == nil || len(rep.Items) != 2 {
			t.Fatalf("report %+v", rep)
		}
		for _, it := range rep.Items {
			if it.Outcome == nil || it.Status != caitlyn.IngestionItemStatusIndexed || it.DocumentID == nil || it.Version == nil {
				t.Fatalf("item %+v", it)
			}
		}
		// A declined confirm's report: the same shape, the batch cancelled.
		m = fresh(t)
		dir, _ = policies(t, 2)
		_, err = client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
			Confirm: func(context.Context, *caitlyn.SyncPlan) (bool, error) { return false, nil }})
		var declined *caitlyn.SyncDeclinedError
		if !errors.As(err, &declined) || declined.Report.Batch == nil || declined.Report.Batch.Status != caitlyn.IngestionBatchStatusCancelled || len(declined.Report.Items) != 2 {
			t.Fatalf("declined %v", err)
		}
	}
}

func init() {
	protocol["sync.estimate-many"] = func(t *testing.T, m mock) {
		// A call limit of 2 in place of 10,000, so five files take three calls.
		var mu sync.Mutex
		var parts []map[string]any
		c := client(t, m, caitlyn.WithHTTPClient(hook{after: func(r *http.Request, resp *http.Response) {
			if strings.HasSuffix(r.URL.Path, "/ingestions:estimate") {
				b, _ := io.ReadAll(resp.Body)
				resp.Body = io.NopCloser(bytes.NewReader(b))
				var part map[string]any
				json.Unmarshal(b, &part)
				mu.Lock()
				parts = append(parts, part)
				mu.Unlock()
			}
		}}))
		dir, _ := policies(t, 5)
		opts := &caitlyn.SyncOptions{Folder: "/hr/"}
		caitlyn.SetSyncEstimatePerCall(opts, 2)
		plan, err := c.KnowledgeBase(kb).Ingestion.EstimateSync(context.Background(), caitlyn.Dir(dir), opts)
		if err != nil {
			t.Fatal(err)
		}
		// In order, at most the limit a call.
		var sizes []int
		var names []string
		for _, r := range m.matching(t, pathHasSuffix("/ingestions:estimate")) {
			docs := jsonBody(t, r)["documents"].([]any)
			sizes = append(sizes, len(docs))
			for _, d := range docs {
				names = append(names, d.(map[string]any)["name"].(string))
			}
		}
		if !reflect.DeepEqual(sizes, []int{2, 2, 1}) || !slices.IsSorted(names) {
			t.Fatalf("calls of %v documents, names %v", sizes, names)
		}
		// One total: counts and ranges summed, details left out.
		var docs, low, high float64
		for _, p := range parts {
			docs += p["documents"].(float64)
			d := p["durationSeconds"].(map[string]any)
			low += d["low"].(float64)
			high += d["high"].(float64)
		}
		e := plan.Estimate
		if e == nil || float64(e.Documents) != docs || e.Documents != 5 || e.DurationSeconds.Low != low || e.DurationSeconds.High != high || e.Details != nil {
			t.Fatalf("estimate %+v; want the parts %v added together", e, parts)
		}
	}
}

// TestGoSyncUploadFailure: an upload that fails after its retries fails only its item, with UPLOAD_FAILED in OnItem
// and the report; it is not sent to Complete, and the other files are ingested.
func TestGoSyncUploadFailure(t *testing.T) {
	m := fresh(t)
	m.faults(t, map[string]any{"failUploads": map[string]any{"/hr/policy-02.pdf": true}})
	dir, _ := policies(t, 3)
	failed := map[string]string{}
	report, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
		OnItem: func(it caitlyn.IngestionBatchItem) {
			if it.Status == caitlyn.IngestionItemStatusFailed {
				failed[deref(it.Path)] = deref(it.FailureCode)
			}
		}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(failed, map[string]string{"/hr/policy-02.pdf": "UPLOAD_FAILED"}) {
		t.Fatalf("failed through OnItem: %v", failed)
	}
	var doomed string
	for _, it := range report.Items {
		switch deref(it.Path) {
		case "/hr/policy-02.pdf":
			doomed = it.ID
			if it.Status != caitlyn.IngestionItemStatusFailed || deref(it.FailureCode) != "UPLOAD_FAILED" {
				t.Fatalf("the failed item in the report: %+v", it)
			}
		default:
			if it.Status != caitlyn.IngestionItemStatusIndexed {
				t.Fatalf("item %+v", it)
			}
		}
	}
	for _, r := range m.matching(t, pathHasSuffix("/complete-uploads")) {
		for _, id := range jsonBody(t, r)["itemIds"].([]any) {
			if id == doomed {
				t.Fatal("the failed upload was reported to Complete")
			}
		}
	}
}
