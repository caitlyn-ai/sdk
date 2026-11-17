package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
)

// One type per thing (PROTOCOL.md 4): every call that gives a thing returns that thing's own type, with its etag as a
// field and the metadata of the response it came from; lists and snapshots give the same types without metadata.

// firstOf is the first item a list yields.
func firstOf[T any](t *testing.T, seq func(func(T, error) bool)) T {
	t.Helper()
	for v, err := range seq {
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	t.Fatal("the list is empty")
	var zero T
	return zero
}

// kbSnapshot is the first event of the knowledge base's watch: its snapshot.
func kbSnapshot(t *testing.T, c *caitlyn.Client) *caitlyn.KnowledgeBaseSnapshot {
	t.Helper()
	w, err := c.KnowledgeBase(kb).Watch(within(t))
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	first, err := take(w, func(caitlyn.KnowledgeBaseEvent) bool { return true })
	if err != nil || len(first) != 1 {
		t.Fatalf("first event %v, %v", first, err)
	}
	snap, ok := first[0].(*caitlyn.KnowledgeBaseSnapshot)
	if !ok || snap.KnowledgeBase == nil {
		t.Fatalf("first event %T", first[0])
	}
	return snap
}

// kbSnapshotOf is the snapshot a scope's watch opens with.
func kbSnapshotOf(t *testing.T, watch func(context.Context, ...caitlyn.CallOption) (*caitlyn.KnowledgeBaseEventStream, error)) *caitlyn.KnowledgeBaseSnapshot {
	t.Helper()
	w, err := watch(within(t))
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	first, err := take(w, func(caitlyn.KnowledgeBaseEvent) bool { return true })
	if err != nil || len(first) != 1 {
		t.Fatalf("first event %v, %v", first, err)
	}
	snap, ok := first[0].(*caitlyn.KnowledgeBaseSnapshot)
	if !ok {
		t.Fatalf("first event %T", first[0])
	}
	return snap
}

// readCounter counts the reads of a stream an estimate must leave alone.
type readCounter struct {
	mu    sync.Mutex
	reads int
}

func (r *readCounter) Read(p []byte) (int, error) {
	r.mu.Lock()
	r.reads++
	r.mu.Unlock()
	return 0, io.EOF
}

// estimateDocuments is each EstimateIngestion or EstimateDocumentVersion request's described files, in order.
func estimateDocuments(t *testing.T, m mock) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, r := range m.api(t) {
		if !strings.HasSuffix(r.Path, "/ingestions:estimate") && !strings.HasSuffix(r.Path, "/versions:estimate") {
			continue
		}
		var body struct {
			Documents []map[string]any `json:"documents"`
			File      map[string]any   `json:"file"`
		}
		if err := json.Unmarshal([]byte(r.Body), &body); err != nil {
			t.Fatal(err)
		}
		out = append(out, body.Documents...)
		if body.File != nil {
			out = append(out, body.File)
		}
	}
	return out
}

func init() {
	protocol["result.thing"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		// A read, an update, a create, a wait: the thing's own type, its fields at the top level
		var got *caitlyn.KnowledgeBase
		got, err := c.KnowledgeBase(kb).Get(ctx)
		if err != nil || got.ID != kb || got.ETag == "" {
			t.Fatalf("get %+v, %v", got, err)
		}
		got, err = c.KnowledgeBase(kb).Update(ctx, &caitlyn.UpdateKnowledgeBaseInput{Name: caitlyn.Ptr("HR policies")}, caitlyn.WithIfMatch(got.ETag))
		if err != nil || got.Name != "HR policies" {
			t.Fatalf("update %+v, %v", got, err)
		}
		created, err := c.KnowledgeBases.Create(ctx, &caitlyn.CreateKnowledgeBaseInput{Name: "Finance"})
		if err != nil {
			t.Fatal(err)
		}
		var thing *caitlyn.KnowledgeBase = created.Result
		if thing.ID == "" || thing.Name != "Finance" {
			t.Fatalf("created %+v", thing)
		}
		got, err = created.Wait(ctx)
		if err != nil || got.ID != thing.ID || got.Status != caitlyn.KnowledgeBaseStatusReady {
			t.Fatalf("wait %+v, %v", got, err)
		}
		var agentThing *caitlyn.Agent
		if agentThing, err = c.Agent(agent).Get(ctx); err != nil || agentThing.ID != agent {
			t.Fatalf("agent %+v, %v", agentThing, err)
		}
		var version *caitlyn.AgentVersion = draft(t, c)
		if version.Name != "draft" {
			t.Fatalf("draft %+v", version)
		}
		var doc *caitlyn.Document
		if doc, err = c.KnowledgeBase(kb).Document("doc-0001").Get(ctx); err != nil || doc.ID != "doc-0001" {
			t.Fatalf("document %+v, %v", doc, err)
		}
		newDoc, err := c.KnowledgeBase(kb).Documents.Create(ctx, caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		// CreateDocument's output is not a thing ({document, operation}): it keeps its named result
		var named *caitlyn.CreateDocumentResult = newDoc.Result
		if doc = &named.Document; doc.ID == "" || doc.Name != "leave-policy.pdf" {
			t.Fatalf("created document %+v", doc)
		}
		// A list's items and a snapshot's entries are the same types
		var item caitlyn.KnowledgeBase = firstOf(t, c.KnowledgeBases.List(ctx, nil))
		var agentItem caitlyn.Agent = firstOf(t, c.Agents.List(ctx, nil))
		var versionItem caitlyn.AgentVersion = firstOf(t, c.Agent(agent).Versions.List(ctx, nil))
		if item.ID == "" || agentItem.ID == "" || versionItem.Name == "" {
			t.Fatalf("list items %+v %+v %+v", item, agentItem, versionItem)
		}
		var entry *caitlyn.KnowledgeBase = kbSnapshot(t, c).KnowledgeBase
		if entry.ID != kb {
			t.Fatalf("snapshot entry %+v", entry)
		}
		// A call whose output is not a thing keeps its named result
		var est *caitlyn.EstimateIngestionResult
		if est, err = c.KnowledgeBase(kb).Documents.EstimateCreate(ctx, caitlyn.FileFromBytes("a.pdf", leavePolicy)); err != nil || est.Documents != 1 {
			t.Fatalf("estimate %+v, %v", est, err)
		}
	}

	protocol["result.thing-metadata"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		got, err := c.KnowledgeBase(kb).Get(ctx)
		if err != nil {
			t.Fatal(err)
		}
		last := lastAPI(t, m)
		if md := got.ResponseMetadata(); md.HTTPStatusCode != 200 || md.RequestID == "" || md.RequestID != last.RequestID || md.APIVersion == "" {
			t.Fatalf("get's metadata %+v (request %s)", md, last.RequestID)
		}
		created, err := c.KnowledgeBases.Create(ctx, &caitlyn.CreateKnowledgeBaseInput{Name: "Finance"})
		if err != nil {
			t.Fatal(err)
		}
		if md := created.Result.ResponseMetadata(); md.HTTPStatusCode != 202 || md.RequestID != lastAPI(t, m).RequestID {
			t.Fatalf("create's metadata %+v", md)
		}
		waited, err := created.Wait(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if md := waited.ResponseMetadata(); md.HTTPStatusCode != 200 || md.RequestID != lastAPI(t, m).RequestID {
			t.Fatalf("wait's metadata %+v", md)
		}
		// A list item and a snapshot entry carry none
		item := firstOf(t, c.KnowledgeBases.List(ctx, nil))
		if item.ResponseMetadata() != (caitlyn.ResponseMetadata{}) {
			t.Fatalf("list item's metadata %+v", item.ResponseMetadata())
		}
		if md := kbSnapshot(t, c).KnowledgeBase.ResponseMetadata(); md != (caitlyn.ResponseMetadata{}) {
			t.Fatalf("snapshot entry's metadata %+v", md)
		}
		// The metadata is never serialised: the JSON has the thing's own members only
		b, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		var members map[string]any
		json.Unmarshal(b, &members)
		for k := range members {
			if _, ok := got.Raw()[k]; !ok {
				t.Fatalf("marshalled %s, which the body did not have: %s", k, b)
			}
		}
		if strings.Contains(string(b), got.ResponseMetadata().RequestID) {
			t.Fatalf("the request id was marshalled: %s", b)
		}
	}

	protocol["result.thing-etag"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		got, err := c.KnowledgeBase(kb).Get(ctx)
		if err != nil || got.ETag == "" || got.Raw()["etag"] != got.ETag {
			t.Fatalf("get's etag %q, raw %v, %v", got.ETag, got.Raw()["etag"], err)
		}
		// The same field, the same value, from a list row and a snapshot entry
		var item caitlyn.KnowledgeBase
		for it, err := range c.KnowledgeBases.List(ctx, nil) {
			if err != nil {
				t.Fatal(err)
			}
			if it.ID == kb {
				item = it
			}
		}
		if item.ETag != got.ETag {
			t.Fatalf("list row's etag %q, get's %q", item.ETag, got.ETag)
		}
		if e := kbSnapshot(t, c).KnowledgeBase.ETag; e != got.ETag {
			t.Fatalf("snapshot entry's etag %q, get's %q", e, got.ETag)
		}
		// A body without etag: the field is filled from the ETag header
		before := draft(t, c)
		m.faults(t, map[string]any{"etagHeaderOnly": true})
		header, err := c.KnowledgeBase(kb).Get(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, inBody := header.Raw()["etag"]; inBody || header.ETag != got.ETag {
			t.Fatalf("etag %q from the header (raw %v)", header.ETag, header.Raw()["etag"])
		}
		version := draft(t, c)
		if _, inBody := version.Raw()["etag"]; inBody || version.ETag == "" || version.ETag != before.ETag {
			t.Fatalf("draft's etag %q from the header", version.ETag)
		}
	}

	protocol["result.thing-raw"] = func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"unknownField": true})
		c := client(t, m)
		v := draft(t, c)
		raw := v.Raw()
		// Unknown fields are kept, beside the thing's own; the response metadata is not in it
		if raw["reviewState"] == nil || raw["name"] != "draft" || raw["etag"] != v.ETag {
			t.Fatalf("raw %v", raw)
		}
		for _, k := range []string{"requestId", "httpStatusCode", "metadata"} {
			if _, ok := raw[k]; ok {
				t.Fatalf("raw holds %s", k)
			}
		}
		var round map[string]any
		if err := json.Unmarshal(v.RawJSON(), &round); err != nil || round["reviewState"] == nil {
			t.Fatalf("raw JSON %s", v.RawJSON())
		}
		got, err := c.KnowledgeBase(kb).Get(context.Background())
		if err != nil || got.Raw()["id"] != kb {
			t.Fatalf("knowledge base raw %v, %v", got.Raw(), err)
		}
	}

	protocol["result.list-etag-if-match"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		// A list row's etag, as ifMatch to that thing's update, is accepted: it is the ETag a read gives
		var row caitlyn.KnowledgeBase
		for it, err := range c.KnowledgeBases.List(ctx, nil) {
			if err != nil {
				t.Fatal(err)
			}
			if it.ID == kb {
				row = it
			}
		}
		updated, err := c.KnowledgeBase(kb).Update(ctx, &caitlyn.UpdateKnowledgeBaseInput{Name: caitlyn.Ptr("HR policies")}, caitlyn.WithIfMatch(row.ETag))
		if err != nil || lastAPI(t, m).Headers["if-match"] != row.ETag || updated.ETag == row.ETag {
			t.Fatalf("knowledge base update with the list row's etag: %v", err)
		}
		agentRow := firstOf(t, c.Agents.List(ctx, nil))
		if _, err := c.Agent(agentRow.ID).Update(ctx, &caitlyn.UpdateAgentInput{Name: caitlyn.Ptr("HR assistant")}, caitlyn.WithIfMatch(agentRow.ETag)); err != nil {
			t.Fatalf("agent update with the list row's etag: %v", err)
		}
		var draftRow caitlyn.AgentVersion
		for v, err := range c.Agent(agent).Versions.List(ctx, nil) {
			if err != nil {
				t.Fatal(err)
			}
			if v.Name == "draft" {
				draftRow = v
			}
		}
		if _, err := c.Agent(agent).Draft().Update(ctx, &caitlyn.UpdateDraftVersionInput{
			Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr("Answer from the HR policies.")},
		}, caitlyn.WithIfMatch(draftRow.ETag)); err != nil || lastAPI(t, m).Headers["if-match"] != draftRow.ETag {
			t.Fatalf("draft update with the list row's etag: %v", err)
		}
	}

	protocol["estimate.caller-hints"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		hints := &caitlyn.IngestionHints{Pages: caitlyn.Ptr[int64](14)}
		check := func(where string, docs []map[string]any) {
			t.Helper()
			if len(docs) != 2 {
				t.Fatalf("%s: described %v", where, docs)
			}
			if h, ok := docs[0]["hints"].(map[string]any); !ok || h["pages"] != 14.0 || len(h) != 1 {
				t.Fatalf("%s: the hinted file's hints %v", where, docs[0]["hints"])
			}
			if _, ok := docs[1]["hints"]; ok {
				t.Fatalf("%s: the file with no hints sent %v", where, docs[1])
			}
			for _, d := range docs {
				if d["name"] == nil || d["contentType"] == nil || d["byteSize"] == nil || d["sha256"] != nil {
					t.Fatalf("%s: described %v", where, d)
				}
			}
		}
		// A stream of known length with no hints is described, never read
		var unread readCounter
		plain := func() caitlyn.File {
			return caitlyn.FileFromReader("handbook.pdf", &unread, caitlyn.WithSize(int64(len(leavePolicy))))
		}
		hinted := func() caitlyn.File {
			return caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy, caitlyn.WithHints(hints))
		}

		docs := c.KnowledgeBase(kb).Documents
		for _, f := range []caitlyn.File{hinted(), plain()} {
			if _, err := docs.EstimateCreate(ctx, f); err != nil {
				t.Fatal(err)
			}
		}
		check("documents.EstimateCreate", estimateDocuments(t, m))

		m = fresh(t)
		doc := client(t, m).KnowledgeBase(kb).Document("doc-0001")
		for _, f := range []caitlyn.File{hinted(), plain()} {
			if _, err := doc.EstimateReplace(ctx, f, nil); err != nil {
				t.Fatal(err)
			}
		}
		check("doc.EstimateReplace", estimateDocuments(t, m))
		if unread.reads != 0 {
			t.Fatalf("the file with no hints was read %d times for an estimate", unread.reads)
		}

		// Sync hashes its files for the batch's items, not for the estimate; the hints still reach the estimate
		m = fresh(t)
		plan, err := client(t, m).KnowledgeBase(kb).Ingestion.EstimateSync(ctx, caitlyn.Files{
			{RelativePath: "leave-policy.pdf", File: hinted()},
			{RelativePath: "handbook.pdf", File: caitlyn.FileFromBytes("handbook.pdf", []byte("%PDF-1.7\nhandbook"))},
		}, &caitlyn.SyncOptions{Folder: "/hr/"})
		if err != nil || plan.Estimate == nil {
			t.Fatalf("sync estimate %+v, %v", plan, err)
		}
		described := estimateDocuments(t, m)
		if len(described) == 2 && described[0]["name"] != "leave-policy.pdf" {
			described[0], described[1] = described[1], described[0]
		}
		check("ingestion.EstimateSync", described)
		// Batch items carry no hints
		for _, r := range m.api(t) {
			if strings.HasSuffix(r.Path, "/ingestions") && strings.Contains(r.Body, "hints") {
				t.Fatalf("a batch item carried hints: %s", r.Body)
			}
		}
	}

	protocol["wait.snapshot-entry"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		k := c.KnowledgeBase(kb)
		// A finished batch, a document at rest and a folder with nothing running on it
		dir, _ := policies(t, 1)
		report, err := k.Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		folder, err := k.Folders.Create(ctx, &caitlyn.CreateFolderInput{Path: "/hr/leave/"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := folder.Wait(ctx); err != nil {
			t.Fatal(err)
		}
		watches := func() int { return len(m.matching(t, pathHasSuffix("/v3/knowledge-bases/"+kb+"/events"))) }
		// Each wait ends on its first snapshot, which already shows the thing done: one watch connection each
		before := watches()
		var batch *caitlyn.IngestionBatch
		if batch, err = k.Ingestion.Batch(report.Batch.ID).Wait(ctx); err != nil || batch.ID != report.Batch.ID || batch.Status != report.Batch.Status {
			t.Fatalf("batch %+v, %v", batch, err)
		}
		var doc *caitlyn.Document
		if doc, err = k.Document("doc-0001").Wait(ctx); err != nil || doc.ID != "doc-0001" || doc.Status != caitlyn.DocumentStatusIndexed {
			t.Fatalf("document %+v, %v", doc, err)
		}
		var f *caitlyn.Folder
		if f, err = k.Folder("/hr/leave/").Wait(ctx); err != nil || f.Path != "/hr/leave/" {
			t.Fatalf("folder %+v, %v", f, err)
		}
		if n := watches() - before; n != 3 {
			t.Fatalf("%d watch connections for three waits", n)
		}
		// A batch's and a document's wait end with their final read, so they carry its metadata
		if batch.ResponseMetadata().HTTPStatusCode != 200 || doc.ResponseMetadata().HTTPStatusCode != 200 {
			t.Fatalf("final reads' metadata %+v %+v", batch.ResponseMetadata(), doc.ResponseMetadata())
		}
		// A folder has no get: its wait returns its Folder as ListFolders gives it
		var row caitlyn.Folder
		for it, err := range k.Folders.List(ctx, nil) {
			if err != nil {
				t.Fatal(err)
			}
			if it.Path == "/hr/leave/" {
				row = it
			}
		}
		if f.Raw()["path"] != "/hr/leave/" || f.ETag == "" || f.ETag != row.ETag || f.Name != row.Name || f.DocumentCount != row.DocumentCount || f.Parent != row.Parent {
			t.Fatalf("folder %+v, ListFolders row %+v", f, row)
		}
	}

	protocol["start.if-match-optional"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		planned := func(name string) (*caitlyn.CreatedBatch, *caitlyn.IngestionBatch) {
			t.Helper()
			pdf := []byte("%PDF-1.7\n" + name)
			b, err := c.KnowledgeBase(kb).Ingestion.Batches.Create(ctx, &caitlyn.CreateIngestionBatchInput{Start: caitlyn.Ptr(caitlyn.StartModeManual),
				Items: []caitlyn.IngestionItemInput{{Path: caitlyn.Ptr("/hr/" + name), SHA256: caitlyn.Ptr(sha(pdf)), ByteSize: caitlyn.Ptr(int64(len(pdf))), ContentType: caitlyn.Ptr("application/pdf")}}})
			if err != nil {
				t.Fatal(err)
			}
			p, err := b.Planned(ctx)
			if err != nil {
				t.Fatal(err)
			}
			return b, p
		}
		// No ifMatch: StartIngestionBatch alone, no If-Match header and no read before it
		b, _ := planned("leave.pdf")
		before := len(m.api(t))
		if _, err := b.Start(ctx); err != nil {
			t.Fatal(err)
		}
		sent := m.api(t)[before:]
		if len(sent) != 1 || sent[0].Method != "POST" || !strings.HasSuffix(sent[0].Path, "/ingestion-batches/"+b.ID()+"/start") {
			t.Fatalf("sent %+v", sent)
		}
		if _, ok := sent[0].Headers["if-match"]; ok {
			t.Fatalf("If-Match %q sent", sent[0].Headers["if-match"])
		}
		// A given one is sent as it is
		b, p := planned("sick.pdf")
		if _, err := b.Start(ctx, caitlyn.WithIfMatch(p.ETag)); err != nil || lastAPI(t, m).Headers["if-match"] != p.ETag {
			t.Fatalf("start with If-Match %q: %v", lastAPI(t, m).Headers["if-match"], err)
		}
		// A stale one fails with 412
		b, _ = planned("travel.pdf")
		_, err := b.Start(ctx, caitlyn.WithIfMatch(`"stale"`))
		var stale *caitlyn.PreconditionFailedError
		if !errors.As(err, &stale) || stale.Code != "PRECONDITION_FAILED" || lastAPI(t, m).Headers["if-match"] != `"stale"` {
			t.Fatalf("stale If-Match: %v", err)
		}
	}

	protocol["watch.event-types"] = func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := within(t)
		k := c.KnowledgeBase(kb)
		folder, err := k.Folders.Create(ctx, &caitlyn.CreateFolderInput{Path: "/hr/leave/"})
		if err != nil {
			t.Fatal(err)
		}
		// A change event's entry is the model's type: its timestamps are time.Time, read from the wire's strings
		w, err := folder.Watch(ctx)
		if err != nil {
			t.Fatal(err)
		}
		events, err := take(w, func(ev caitlyn.KnowledgeBaseEvent) bool { _, ok := ev.(*caitlyn.FolderChanged); return ok })
		w.Close()
		if err != nil {
			t.Fatal(err)
		}
		snap, ok := events[0].(*caitlyn.KnowledgeBaseSnapshot)
		changed, ok2 := events[len(events)-1].(*caitlyn.FolderChanged)
		if !ok || !ok2 || snap.Folder == nil {
			t.Fatalf("events %v", events)
		}
		var at time.Time = changed.Folder.UpdatedAt
		wire, _ := changed.Folder.Raw()["updatedAt"].(string)
		if parsed, err := time.Parse(time.RFC3339Nano, wire); err != nil || at.IsZero() || !parsed.Equal(at) {
			t.Fatalf("change event's updatedAt %v (raw %v)", at, changed.Folder.Raw()["updatedAt"])
		}
		if snap.Folder.UpdatedAt.IsZero() {
			t.Fatalf("snapshot entry's updatedAt %v", snap.Folder.UpdatedAt)
		}
		doc := firstOf(t, k.Documents.List(ctx, nil))
		snapDoc := kbSnapshotOf(t, k.Document(doc.ID).Watch).Document
		var created, updated time.Time = snapDoc.CreatedAt, snapDoc.UpdatedAt
		if !created.Equal(doc.CreatedAt) || !updated.Equal(doc.UpdatedAt) {
			t.Fatalf("snapshot document's times %v %v, list's %v %v", created, updated, doc.CreatedAt, doc.UpdatedAt)
		}
		// So a folder's wait and ListFolders give the same Folder
		waited, err := folder.Wait(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for row, err := range k.Folders.List(ctx, nil) {
			if err != nil {
				t.Fatal(err)
			}
			if row.Path == waited.Path {
				a, _ := json.Marshal(row)
				b, _ := json.Marshal(waited)
				if string(a) != string(b) || !row.UpdatedAt.Equal(waited.UpdatedAt) {
					t.Fatalf("ListFolders %s, wait %s", a, b)
				}
				return
			}
		}
		t.Fatalf("ListFolders has no %s", waited.Path)
	}

	protocol["watch.break-closes"] = func(t *testing.T, m mock) {
		c := client(t, m)
		// disconnected waits up to a second for the mock to log the watch's connection closing, after which nothing
		// more may be sent
		disconnected := func(way string, before int) {
			t.Helper()
			deadline := time.Now().Add(time.Second)
			for {
				log := m.requests(t)[before:]
				for i, r := range log {
					if r.Event == "client-disconnected" {
						for _, later := range log[i+1:] {
							if later.Event == "" {
								t.Fatalf("%s: %s %s sent after the disconnect", way, later.Method, later.Path)
							}
						}
						return
					}
				}
				if time.Now().After(deadline) {
					t.Fatalf("%s: no client-disconnected within a second: %+v", way, log)
				}
				time.Sleep(20 * time.Millisecond)
			}
		}
		// Stopping the iterator with break
		before := len(m.requests(t))
		w, err := c.KnowledgeBase(kb).Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		for _, err := range w.Events() {
			if err != nil {
				t.Fatal(err)
			}
			break
		}
		disconnected("break", before)
		// Cancelling the context, with the stream neither drained nor closed
		before = len(m.requests(t))
		ctx, cancel := context.WithCancel(context.Background())
		w, err = c.KnowledgeBase(kb).Watch(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		if _, err := take(w, func(caitlyn.KnowledgeBaseEvent) bool { return true }); err != nil {
			t.Fatal(err)
		}
		cancel()
		disconnected("cancel", before)
	}

	protocol["send.break-then-final"] = func(t *testing.T, m mock) {
		c := client(t, m)
		breakAfterFirst := func(s *caitlyn.ConversationEventStream) {
			t.Helper()
			for _, err := range s.Events() {
				if err != nil {
					t.Fatal(err)
				}
				break
			}
		}
		// After a break, FinalMessage drains the stream, returns the completed message and closes it
		s := send(t, c, context.Background(), "c-final")
		breakAfterFirst(s)
		answer, err := s.FinalMessage()
		if err != nil || answer == nil || answer.ID == "" || answer.Text == "" {
			t.Fatalf("final message %+v, %v", answer, err)
		}
		sent := len(m.api(t))
		if again, err := s.FinalMessage(); err != nil || again != answer || len(m.api(t)) != sent {
			t.Fatalf("a second FinalMessage %+v, %v", again, err)
		}
		// A stream left after a break closes on Close, or when its context is cancelled. The mock holds the answer
		// after the event the caller breaks at, so it cannot finish the answer before the client leaves
		m.faults(t, map[string]any{"holdAfterEvents": 1})
		disconnected := func(way string, before int) {
			t.Helper()
			deadline := time.Now().Add(5 * time.Second)
			for {
				log := m.requests(t)[before:]
				holding := slices.IndexFunc(log, func(l logged) bool { return l.Event == "server-holding-stream" })
				left := slices.IndexFunc(log, func(l logged) bool { return l.Event == "client-disconnected" })
				if left >= 0 {
					if holding < 0 || holding > left {
						t.Fatalf("%s: the client left at %d, the server held from %d", way, left, holding)
					}
					for _, later := range log[left+1:] {
						if later.Event == "" {
							t.Fatalf("%s: %s %s sent after the disconnect", way, later.Method, later.Path)
						}
					}
					return
				}
				if time.Now().After(deadline) {
					t.Fatalf("%s: no client-disconnected within 5 s", way)
				}
				time.Sleep(20 * time.Millisecond)
			}
		}
		before := len(m.requests(t))
		s = send(t, c, context.Background(), "c-close")
		breakAfterFirst(s)
		s.Close()
		disconnected("Close", before)

		before = len(m.requests(t))
		ctx, cancel := context.WithCancel(context.Background())
		s = send(t, c, ctx, "c-cancel")
		breakAfterFirst(s)
		cancel()
		disconnected("cancel", before)
	}
}
