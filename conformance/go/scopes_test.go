package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
)

// The DX redesign's cases: scopes (PROTOCOL.md 10), the readers shorthand, and watching and waiting (16).

func init() {
	for id, run := range scopeCases {
		protocol[id] = run
	}
}

// within bounds a test's waits: a mock job takes a few watch looks of 10 ms, so a wait that has not ended in this
// long never will.
func within(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// accessETag reads a scope's access for its ETag.
func accessETag(t *testing.T, get func(context.Context, ...caitlyn.CallOption) (*caitlyn.Access, error)) string {
	t.Helper()
	a, err := get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return a.ETag
}

func lastAPI(t *testing.T, m mock) logged {
	t.Helper()
	reqs := m.api(t)
	if len(reqs) == 0 {
		t.Fatal("nothing was sent")
	}
	return reqs[len(reqs)-1]
}

var scopeCases = map[string]func(t *testing.T, m mock){
	"scope.sends-nothing": func(t *testing.T, m mock) {
		c := client(t, m)
		kbs := c.KnowledgeBase(kb)
		_ = kbs.Document("doc-0001").Version("1")
		_ = kbs.Document("doc-0001").Access
		_ = kbs.Folder("/hr/investigations/").Access
		_ = kbs.Field("policyOwner")
		_ = kbs.Ingestion.Batch("0193a6f3-0001-7a2b-8c3d-4e5f60718293").Item("item-0001")
		_ = c.Agent(agent).Draft().Conversations
		_ = c.Agent(agent).Live()
		_ = c.Agent(agent).Version("v13")
		_ = c.Agent(agent).HistoryEntry("entry-1")
		_ = c.Conversation("c-1")
		_ = c.Core.Operation(kb, "op-1")
		_ = c.Core.Upload("up-1")
		if reqs := m.requests(t); len(reqs) != 0 {
			t.Fatalf("making scopes sent %d requests", len(reqs))
		}
	},

	"scope.fills-identifiers": func(t *testing.T, m mock) {
		c := client(t, m)
		if _, err := c.KnowledgeBase(kb).Document("doc-0002").Get(context.Background()); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Method != "GET" || r.Path != "/v3/knowledge-bases/"+kb+"/documents/doc-0002" {
			t.Fatalf("sent %s %s", r.Method, r.Path)
		}
		// A folder scope takes its path as people write it; a request path carries it without its first and last /.
		if _, err := c.KnowledgeBase(kb).Folder("/hr/investigations/").Delete(context.Background()); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Method != "DELETE" || r.Path != "/v3/knowledge-bases/"+kb+"/folders/hr/investigations" {
			t.Fatalf("sent %s %s", r.Method, r.Path)
		}
	},

	"scope.named": func(t *testing.T, m mock) {
		c := client(t, m)
		a := c.Agent(agent)
		live, err := a.Live().Get(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Path != "/v3/agents/"+agent+"/versions/live" || live.Name != "live" {
			t.Fatalf("live: %s, name %q", r.Path, live.Name)
		}
		if _, err := a.Draft().Get(context.Background()); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Path != "/v3/agents/"+agent+"/versions/draft" {
			t.Fatalf("draft: %s", r.Path)
		}
		// The draft is one scope with the Draft singleton: its Update is UpdateDraftVersion, If-Match optional.
		if _, err := a.Draft().Update(context.Background(), &caitlyn.UpdateDraftVersionInput{Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr("Cite the clause.")}}); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Method != "PATCH" || r.Path != "/v3/agents/"+agent+"/versions/draft" || r.Headers["if-match"] != "" {
			t.Fatalf("draft update: %s %s, If-Match %q", r.Method, r.Path, r.Headers["if-match"])
		}
		// Live leaves out publish and delete; a named version has them.
		for _, name := range []string{"Publish", "Delete", "Update"} {
			if _, ok := reflect.TypeOf(a.Live()).MethodByName(name); ok {
				t.Fatalf("live has %s", name)
			}
		}
		for _, name := range []string{"Publish", "Delete", "Get", "Compare"} {
			if _, ok := reflect.TypeOf(a.Version("v13")).MethodByName(name); !ok {
				t.Fatalf("a named version lacks %s", name)
			}
		}
		if _, ok := reflect.TypeOf(a.Draft()).MethodByName("Delete"); ok {
			t.Fatal("the draft has Delete")
		}
	},

	"scope.from-scope": func(t *testing.T, m mock) {
		c := client(t, m)
		k := c.KnowledgeBase(kb)
		if _, err := k.Folder("/hr/").Access.Get(context.Background()); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Path != "/v3/knowledge-bases/"+kb+"/access" || r.Query != "?folder=%2Fhr%2F" {
			t.Fatalf("folder access: %s?%s", r.Path, r.Query)
		}
		etag := accessETag(t, k.Document("doc-0001").Access.Get)
		if _, err := k.Document("doc-0001").Access.Set(context.Background(), &caitlyn.PutAccessInput{Readers: caitlyn.ReadersEveryone()}, caitlyn.WithIfMatch(etag)); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Method != "PUT" || r.Query != "?document=doc-0001" {
			t.Fatalf("document access: %s ?%s", r.Method, r.Query)
		}
		if _, err := k.Access.Get(context.Background()); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Path != "/v3/knowledge-bases/"+kb+"/access" || r.Query != "" {
			t.Fatalf("knowledge base access: %s?%s", r.Path, r.Query)
		}
	},

	"scope.create-returns-scope": func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := context.Background()
		a, err := c.Agents.Create(ctx, &caitlyn.CreateAgentInput{Name: "HR assistant"})
		if err != nil {
			t.Fatal(err)
		}
		// The new agent as Result, and its scope at once: no second lookup.
		if a.ID() == "" || a.Result.ID != a.ID() || a.Result.Name != "HR assistant" {
			t.Fatalf("created %+v", a.Result)
		}
		if _, err := a.Draft().Get(ctx); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Path != "/v3/agents/"+a.ID()+"/versions/draft" {
			t.Fatalf("the new agent's draft: %s", r.Path)
		}
		d, err := c.KnowledgeBase(kb).Documents.Create(ctx, caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := d.Get(ctx); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); d.ID() == "" || r.Path != "/v3/knowledge-bases/"+kb+"/documents/"+d.ID() {
			t.Fatalf("the new document: %s", r.Path)
		}
		f, err := c.KnowledgeBase(kb).Folders.Create(ctx, &caitlyn.CreateFolderInput{Path: "/hr/leave/"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Access.Get(ctx); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Query != "?folder=%2Fhr%2Fleave%2F" {
			t.Fatalf("the new folder's access: ?%s", r.Query)
		}
	},

	"scope.core": func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := context.Background()
		up, err := c.Core.Uploads.Reserve(ctx, &caitlyn.CreateUploadInput{FileName: "a.pdf", ContentType: "application/pdf", ByteSize: 1, SHA256: sha([]byte("a"))})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Core.Upload(up.ID).Get(ctx); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Path != "/v3/uploads/"+up.ID {
			t.Fatalf("core.uploads(id).get: %s", r.Path)
		}
		b, err := c.KnowledgeBase(kb).Ingestion.Batches.Create(ctx, &caitlyn.CreateIngestionBatchInput{Start: caitlyn.Ptr(caitlyn.StartModeManual), AwaitMoreItems: caitlyn.Ptr(true)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Core.Ingestion.AddItems(ctx, kb, b.ID(), &caitlyn.BatchCreateIngestionBatchItemsInput{Last: caitlyn.Ptr(true),
			Items: []caitlyn.IngestionItemInput{{Path: caitlyn.Ptr("/hr/a.pdf"), SHA256: caitlyn.Ptr(sha([]byte("a"))), ByteSize: caitlyn.Ptr[int64](1), ContentType: caitlyn.Ptr("application/pdf")}}}); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Path != "/v3/knowledge-bases/"+kb+"/ingestion-batches/"+b.ID()+"/items:batch-create" {
			t.Fatalf("core.ingestion.addItems: %s", r.Path)
		}
		job, err := c.KnowledgeBase(kb).Fields.FillIn(ctx, &caitlyn.FillInFieldsInput{Keys: []string{"policyOwner"}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Core.Operation(kb, job.Result.Job.ID).Get(ctx); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Path != "/v3/knowledge-bases/"+kb+"/operations/"+job.Result.Job.ID {
			t.Fatalf("core.operations(kb, id).get: %s", r.Path)
		}
	},

	"scope.estimate": func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := context.Background()
		est, err := c.KnowledgeBase(kb).Fields.EstimateFillIn(ctx, &caitlyn.FillInFieldsInput{Keys: []string{"policyOwner"}})
		if err != nil {
			t.Fatal(err)
		}
		r := lastAPI(t, m)
		if r.Method != "POST" || r.Path != "/v3/knowledge-bases/"+kb+"/fields:estimate-fill-in" ||
			!reflect.DeepEqual(jsonBody(t, r), map[string]any{"keys": []any{"policyOwner"}}) || est.Documents == 0 {
			t.Fatalf("EstimateFillIn sent %s %s %s, got %+v", r.Method, r.Path, r.Body, est)
		}
		pdf := []byte("%PDF-1.7\nLeave policy.\n")
		if _, err := c.KnowledgeBase(kb).Documents.EstimateCreate(ctx, caitlyn.FileFromBytes("leave-policy.pdf", pdf)); err != nil {
			t.Fatal(err)
		}
		reqs := m.requests(t)
		r = reqs[len(reqs)-1]
		want := map[string]any{"documents": []any{map[string]any{"name": "leave-policy.pdf", "contentType": "application/pdf", "byteSize": float64(len(pdf))}}}
		if r.Path != "/v3/knowledge-bases/"+kb+"/ingestions:estimate" || !reflect.DeepEqual(jsonBody(t, r), want) {
			t.Fatalf("EstimateCreate sent %s %s", r.Path, r.Body)
		}
		if len(m.matching(t, isReserve)) != 0 || len(m.matching(t, isPut)) != 0 {
			t.Fatal("an estimate uploaded the file")
		}
	},

	"access.readers-shorthand": func(t *testing.T, m mock) {
		c := client(t, m)
		folder := c.KnowledgeBase(kb).Folder("/hr/investigations/")
		cases := []struct {
			readers *caitlyn.Readers
			want    map[string]any
		}{
			{caitlyn.ReadersOf([]string{"hr-team"}, nil), map[string]any{"kind": "specific", "roles": []any{"hr-team"}}},
			{&caitlyn.Readers{Roles: []string{"hr-team"}, People: []string{"u-1"}}, map[string]any{"kind": "specific", "roles": []any{"hr-team"}, "people": []any{"u-1"}}},
			{caitlyn.ReadersEveryone(), map[string]any{"kind": "everyone"}},
			{caitlyn.ReadersPublic(), map[string]any{"kind": "public"}},
			{caitlyn.ReadersInherit(), map[string]any{"kind": "inherit"}},
		}
		for _, tc := range cases {
			etag := accessETag(t, folder.Access.Get)
			got, err := folder.Access.Set(context.Background(), &caitlyn.PutAccessInput{Readers: tc.readers}, caitlyn.WithIfMatch(etag))
			if err != nil {
				t.Fatal(err)
			}
			if body := jsonBody(t, lastAPI(t, m)); !reflect.DeepEqual(body, map[string]any{"readers": tc.want}) {
				t.Fatalf("sent %v, want readers %v", body, tc.want)
			}
			if got.Readers == nil || string(got.Readers.Kind) != tc.want["kind"] {
				t.Fatalf("set %+v", got.Readers)
			}
		}
	},

	"access.public": func(t *testing.T, m mock) {
		c := client(t, m)
		folder := c.KnowledgeBase(kb).Folder("/policies/")
		if _, err := folder.Access.Set(context.Background(), &caitlyn.PutAccessInput{Readers: caitlyn.ReadersPublic()}); err != nil {
			t.Fatal(err)
		}
		if body := jsonBody(t, lastAPI(t, m)); !reflect.DeepEqual(body, map[string]any{"readers": map[string]any{"kind": "public"}}) {
			t.Fatalf("sent %v", body)
		}
		read, err := folder.Access.Get(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if read.Readers == nil || read.Readers.Kind != caitlyn.ReadersKindPublic || !read.Readers.Kind.Known() {
			t.Fatalf("read %+v", read.Readers)
		}
		doc := c.KnowledgeBase(kb).Document("doc-0001")
		if _, err := doc.Access.Set(context.Background(), &caitlyn.PutAccessInput{Readers: &caitlyn.Readers{Kind: caitlyn.ReadersKindPublic}}); err != nil {
			t.Fatal(err)
		}
		if got, err := doc.Access.Get(context.Background()); err != nil || got.Readers == nil || got.Readers.Kind != "public" {
			t.Fatalf("document readers %+v, %v", got, err)
		}
	},

	"access.set-no-if-match": func(t *testing.T, m mock) {
		c := client(t, m)
		folder := c.KnowledgeBase(kb).Folder("/hr/investigations/")
		set, err := folder.Access.Set(context.Background(), &caitlyn.PutAccessInput{Readers: caitlyn.ReadersOf([]string{"hr-team"}, nil)})
		if err != nil {
			t.Fatal(err)
		}
		// No If-Match, and no read first.
		reqs := m.api(t)
		if len(reqs) != 1 || reqs[0].Method != "PUT" || reqs[0].Headers["if-match"] != "" {
			t.Fatalf("requests %+v", reqs)
		}
		// A given If-Match is sent as it is; a stale one fails with 412.
		if _, err := folder.Access.Set(context.Background(), &caitlyn.PutAccessInput{Readers: caitlyn.ReadersEveryone()}, caitlyn.WithIfMatch(set.ETag)); err != nil {
			t.Fatal(err)
		}
		if r := lastAPI(t, m); r.Headers["if-match"] != set.ETag {
			t.Fatalf("If-Match %q, want %q", r.Headers["if-match"], set.ETag)
		}
		_, err = folder.Access.Set(context.Background(), &caitlyn.PutAccessInput{Readers: caitlyn.ReadersInherit()}, caitlyn.WithIfMatch(set.ETag))
		var stale *caitlyn.PreconditionFailedError
		if !errors.As(err, &stale) {
			t.Fatalf("a stale If-Match gave %v, want *PreconditionFailedError", err)
		}
	},

	"watch.snapshot-first": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}})
		w, err := client(t, m).KnowledgeBase(kb).Document("doc-0001").Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		events, err := take(w, func(ev caitlyn.KnowledgeBaseEvent) bool { return ev.EventType() == "job.finished" })
		if err != nil {
			t.Fatal(err)
		}
		snap, ok := events[0].(*caitlyn.KnowledgeBaseSnapshot)
		if !ok || snap.Document == nil || snap.Document.ID != "doc-0001" || len(snap.Jobs) != 1 {
			t.Fatalf("first event %#v", events[0])
		}
		var types []string
		for _, ev := range events[1:] {
			types = append(types, ev.EventType())
		}
		if !isSubsequence([]string{"document.progress", "job.progress", "document.updated", "job.finished"}, types) {
			t.Fatalf("then %v", types)
		}
		if r := m.matching(t, pathHasSuffix("/events")); len(r) != 1 || r[0].Query != "?document=doc-0001" {
			t.Fatalf("watch requests %+v", r)
		}
	},

	"watch.reconnect-snapshot": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}, "watchDrops": map[string]any{"count": 1, "afterEvents": 2}})
		w, err := client(t, m).KnowledgeBase(kb).Document("doc-0001").Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		snapshots := 0
		events, err := take(w, func(ev caitlyn.KnowledgeBaseEvent) bool {
			if ev.EventType() == "snapshot" {
				snapshots++
			}
			return snapshots == 2
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(events) != 3 || events[0].EventType() != "snapshot" || events[2].EventType() != "snapshot" {
			var types []string
			for _, ev := range events {
				types = append(types, ev.EventType())
			}
			t.Fatalf("events %v; want the snapshot, one change, the connection cut, then a new snapshot first", types)
		}
		reqs := m.matching(t, pathHasSuffix("/events"))
		if len(reqs) != 2 || reqs[1].Query != "?document=doc-0001" || reqs[1].Headers["last-event-id"] != "" {
			t.Fatalf("reconnect %+v; want the same filter and no cursor", reqs)
		}
	},

	"wait.done": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}})
		doc, err := client(t, m).KnowledgeBase(kb).Document("doc-0001").Wait(within(t))
		if err != nil {
			t.Fatal(err)
		}
		// The thing as its get gives it, read once the watch shows nothing running.
		if doc.ID != "doc-0001" || doc.Status != caitlyn.DocumentStatusIndexed {
			t.Fatalf("waited for %+v", doc)
		}
		reqs := m.api(t)
		if last := reqs[len(reqs)-1]; last.Method != "GET" || last.Path != "/v3/knowledge-bases/"+kb+"/documents/doc-0001" {
			t.Fatalf("last request %s %s", last.Method, last.Path)
		}
	},

	"wait.partial": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}, "jobOutcomes": map[string]any{"doc-0001": "completed_with_failures"}})
		doc, err := client(t, m).KnowledgeBase(kb).Document("doc-0001").Wait(within(t))
		if err != nil {
			t.Fatal(err)
		}
		if doc.Status != caitlyn.DocumentStatusPartiallyIndexed || len(doc.PartialFailures) == 0 || doc.PartialFailures[0].Code != "PICTURE_DESCRIPTION_FAILED" {
			t.Fatalf("waited for %+v", doc)
		}
	},

	"wait.failed": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}, "jobOutcomes": map[string]any{"doc-0001": "failed"}})
		_, err := client(t, m).KnowledgeBase(kb).Document("doc-0001").Wait(within(t))
		var unprocessable *caitlyn.UnprocessableContentError
		if !errors.As(err, &unprocessable) || unprocessable.Code != "CONTENT_REJECTED" || !strings.Contains(err.Error(), "could not be read") {
			t.Fatalf("got %T %v; want the job's error as the class for CONTENT_REJECTED", err, err)
		}
		m = fresh(t)
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0002": true}, "jobOutcomes": map[string]any{"doc-0002": "cancelled"}})
		_, err = client(t, m).KnowledgeBase(kb).Document("doc-0002").Wait(within(t))
		if sdkCode(err) != "CANCELLED" {
			t.Fatalf("got %v; want CANCELLED", err)
		}
	},

	"wait.gone": func(t *testing.T, m mock) {
		c := client(t, m)
		del, err := c.KnowledgeBase(kb).Document("doc-0002").Delete(within(t))
		if err != nil {
			t.Fatal(err)
		}
		if err := del.Wait(within(t)); err != nil {
			t.Fatalf("after a delete: %v", err)
		}
		if _, err := c.KnowledgeBase(kb).Document("doc-0002").Get(context.Background()); !isNotFound(err) {
			t.Fatalf("the document is still there: %v", err)
		}
		folder, err := c.KnowledgeBase(kb).Folder("/archive/").Delete(within(t))
		if err != nil {
			t.Fatal(err)
		}
		if err := folder.Wait(within(t)); err != nil {
			t.Fatalf("after a folder's delete: %v", err)
		}
		// On anything but a delete, a thing that is gone ends the wait with the 404.
		var nf *caitlyn.NotFoundError
		if _, err := c.KnowledgeBase(kb).Document("doc-nope").Wait(within(t)); !errors.As(err, &nf) {
			t.Fatalf("got %T %v; want *NotFoundError", err, err)
		}
	},

	"wait.started-work": func(t *testing.T, m mock) {
		c := client(t, m)
		k := c.KnowledgeBase(kb)
		// Add a document: Create returns the new document's scope, whose Wait follows the ingestion it started.
		d, err := k.Documents.Create(within(t), caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		doc, err := d.Wait(within(t))
		if err != nil || doc.ID != d.ID() || doc.Status != caitlyn.DocumentStatusIndexed {
			t.Fatalf("waited for %+v, %v", doc, err)
		}
		// A call on an existing thing: the response as Result, with Watch and Wait following the work it started.
		replaced, err := k.Document(d.ID()).Replace(within(t), caitlyn.FileFromBytes("leave-policy.pdf", []byte("%PDF-1.7\nThe 2027 edition.\n")), nil)
		if err != nil {
			t.Fatal(err)
		}
		if replaced.Result == nil || replaced.Result.Version.Number != 2 {
			t.Fatalf("result %+v", replaced.Result)
		}
		w, err := replaced.Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		first, err := take(w, func(caitlyn.KnowledgeBaseEvent) bool { return true })
		w.Close()
		if err != nil || len(first) != 1 || first[0].EventType() != "snapshot" {
			t.Fatalf("watch on started work: %v, %v", first, err)
		}
		if r := m.matching(t, pathHasSuffix("/events")); r[len(r)-1].Query != "?document="+d.ID() {
			t.Fatalf("watched %s", r[len(r)-1].Query)
		}
		if doc, err := replaced.Wait(within(t)); err != nil || doc.Version == nil || *doc.Version != 2 {
			t.Fatalf("waited for %+v, %v", doc, err)
		}
		// A fill-in has no thing of its own: Wait follows its job, and returns it.
		f, err := k.Fields.FillIn(within(t), &caitlyn.FillInFieldsInput{Keys: []string{"policyOwner"}})
		if err != nil {
			t.Fatal(err)
		}
		job, err := f.Wait(within(t))
		if err != nil || job.ID != f.Result.Job.ID || job.Status != caitlyn.OperationStatusSucceeded {
			t.Fatalf("waited for %+v, %v", job, err)
		}
		// A knowledge base being created: Wait returns it once it is ready.
		created, err := c.KnowledgeBases.Create(within(t), &caitlyn.CreateKnowledgeBaseInput{Name: "Orchard knowledge base"})
		if err != nil {
			t.Fatal(err)
		}
		ready, err := created.Wait(within(t))
		if err != nil || ready.ID != created.ID() || ready.Status != caitlyn.KnowledgeBaseStatusReady {
			t.Fatalf("waited for %+v, %v", ready, err)
		}
	},

	"wait.planned": func(t *testing.T, m mock) {
		c := client(t, m)
		pdf := []byte("%PDF-1.7\nLeave policy.\n")
		b, err := c.KnowledgeBase(kb).Ingestion.Batches.Create(within(t), &caitlyn.CreateIngestionBatchInput{Start: caitlyn.Ptr(caitlyn.StartModeManual),
			Items: []caitlyn.IngestionItemInput{{Path: caitlyn.Ptr("/hr/leave.pdf"), SHA256: caitlyn.Ptr(sha(pdf)), ByteSize: caitlyn.Ptr(int64(len(pdf))), ContentType: caitlyn.Ptr("application/pdf")}}})
		if err != nil {
			t.Fatal(err)
		}
		planned, err := b.Planned(within(t))
		if err != nil || planned.ID != b.ID() || planned.Status != caitlyn.IngestionBatchStatusPlanned {
			t.Fatalf("planned %+v, %v", planned, err)
		}
		if reqs := m.matching(t, pathHasSuffix("/events")); len(reqs) == 0 || reqs[0].Query != "?batch="+b.ID() {
			t.Fatalf("watch requests %+v", reqs)
		}
	},

	"wait.delete-processing": func(t *testing.T, m mock) {
		k := client(t, m).KnowledgeBase(kb)
		d, err := k.Documents.Create(within(t), caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		// Deleted at once, while it is being processed: accepted; the job the delete stopped ends cancelled, which is
		// part of the delete, so the wait ends on the gone rule with no CANCELLED.
		deleted, err := d.Delete(within(t))
		if err != nil {
			t.Fatalf("the delete: %v", err)
		}
		if err := deleted.Wait(within(t)); err != nil {
			t.Fatalf("the delete's wait: %v", err)
		}
		if _, err := d.Get(context.Background()); !isNotFound(err) {
			t.Fatalf("after the delete: %v, want a 404", err)
		}
	},

	"wait.busy-status": func(t *testing.T, m mock) {
		c := client(t, m)
		created, err := c.KnowledgeBases.Create(within(t), &caitlyn.CreateKnowledgeBaseInput{Name: "Orchard knowledge base"})
		if err != nil {
			t.Fatal(err)
		}
		// A scope made from the identifier, with no job to follow: the snapshot lists none, but the knowledge base is
		// creating, so the wait carries on until it is ready.
		ready, err := c.KnowledgeBase(created.ID()).Wait(within(t))
		if err != nil || ready.Status != caitlyn.KnowledgeBaseStatusReady {
			t.Fatalf("waited for %+v, %v", ready, err)
		}
	},

	"wait.timeout": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}, "jobSteps": 100000})
		start := time.Now()
		_, err := client(t, m).KnowledgeBase(kb).Document("doc-0001").Wait(within(t), caitlyn.WithTimeLimit(300*time.Millisecond))
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "WAIT_TIMEOUT" || e.Status != 0 || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("got %T %v; want WAIT_TIMEOUT that is context.DeadlineExceeded", err, err)
		}
		if time.Since(start) > 10*time.Second {
			t.Fatalf("the limit took %v", time.Since(start))
		}
		// The watch is closed.
		for i := 0; len(m.matching(t, func(r logged) bool { return r.Event == "client-disconnected" })) == 0; i++ {
			if i == 100 {
				t.Fatal("the watch connection was left open")
			}
			time.Sleep(20 * time.Millisecond)
		}
	},

	"scope.download": func(t *testing.T, m mock) {
		c := client(t, m)
		download, err := c.KnowledgeBase(kb).Document("doc-0001").Download(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if download.URL == "" || download.ExpiresAt.IsZero() {
			t.Fatalf("download %+v", download)
		}
		// GetDocumentDownload, and nothing sent to the address.
		if reqs := m.requests(t); len(reqs) != 1 || !strings.HasSuffix(reqs[0].Path, "/documents/doc-0001/download") {
			t.Fatalf("requests %+v", reqs)
		}
		// The 302 is the building block core.Documents.Content, returned as it is, not followed.
		content, err := c.Core.Documents.Content(context.Background(), kb, "doc-0001", nil)
		if err != nil {
			t.Fatal(err)
		}
		if content.URL == "" || content.Location != content.URL || len(m.requests(t)) != 2 {
			t.Fatalf("content %+v, %d requests", content, len(m.requests(t)))
		}
	},

	"core.content-redirect": func(t *testing.T, m mock) {
		// The SDK's own client, and a caller's *http.Client that would follow redirects: neither does.
		for _, c := range []*caitlyn.Client{client(t, m), client(t, m, caitlyn.WithHTTPClient(&http.Client{}))} {
			fresh(t)
			content, err := c.Core.Documents.Content(context.Background(), kb, "doc-0001", nil)
			if err != nil {
				t.Fatal(err)
			}
			if content.Location == "" || content.ResponseMetadata().HTTPStatusCode != 302 {
				t.Fatalf("content %+v, status %d", content, content.ResponseMetadata().HTTPStatusCode)
			}
			if reqs := m.requests(t); len(reqs) != 1 || !strings.HasSuffix(reqs[0].Path, "/documents/doc-0001/content") {
				t.Fatalf("requests %+v; want only GetDocumentContent, nothing sent to the address", reqs)
			}
		}
	},

	"send.text": func(t *testing.T, m mock) {
		s, err := client(t, m).Conversation("c-text").Send(context.Background(), "How much leave?")
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		var parts []string
		for text, err := range caitlyn.Text(s) {
			if err != nil {
				t.Fatal(err)
			}
			parts = append(parts, text)
		}
		if strings.Join(parts, "") != "Staff receive 20 days of annual leave." || len(parts) != 2 {
			t.Fatalf("text %q", parts)
		}
	},

	"send.attachments": func(t *testing.T, m mock) {
		c := client(t, m)
		ctx := context.Background()
		conv := c.Conversation("c-attach")
		// An upload already reserved for this conversation and sent, passed through as it is.
		purpose := &caitlyn.UploadPurpose{ConversationID: caitlyn.Ptr("c-attach")}
		pre, err := c.Core.Uploads.Send(ctx, caitlyn.FileFromBytes("staff-list.md", []byte("# Staff\n")), purpose)
		if err != nil {
			t.Fatal(err)
		}
		form := writeFile(t, t.TempDir(), "leave-form.md", []byte("# Leave form\n\nTen days, from 3 March.\n"))
		files := func() []caitlyn.File {
			return []caitlyn.File{caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy), caitlyn.Path(form), caitlyn.UploadID(pre.ID)}
		}
		// The requests after the one upload made above.
		after := func(pred func(logged) bool) []logged {
			var out []logged
			for _, r := range m.matching(t, pred) {
				if !strings.HasSuffix(r.Path, pre.ID) {
					out = append(out, r)
				}
			}
			return out
		}
		reservedBefore := len(m.matching(t, isReserve))
		s, err := conv.Send(ctx, "Does this leave form match our policy?", caitlyn.WithAttachments(files()...))
		if err != nil {
			t.Fatal(err)
		}
		s.Close()
		reserves := m.matching(t, isReserve)[reservedBefore:]
		if len(reserves) != 2 {
			t.Fatalf("%d uploads reserved, want the two files", len(reserves))
		}
		for _, r := range reserves {
			if !reflect.DeepEqual(jsonBody(t, r)["purpose"], map[string]any{"conversationId": "c-attach"}) {
				t.Fatalf("reserved %v", jsonBody(t, r))
			}
		}
		puts := after(isPut)
		sends := m.matching(t, func(r logged) bool { return r.Method == "POST" && r.Path == "/v3/conversations/c-attach/messages" })
		if len(puts) != 2 || len(sends) != 1 {
			t.Fatalf("%d PUTs, %d messages", len(puts), len(sends))
		}
		// One message naming every upload, in the order given; the upload id passed through as it is.
		want := []any{
			map[string]any{"uploadId": strings.TrimPrefix(puts[0].Path, "/__s3/")},
			map[string]any{"uploadId": strings.TrimPrefix(puts[1].Path, "/__s3/")},
			map[string]any{"uploadId": pre.ID},
		}
		if body := jsonBody(t, sends[0]); !reflect.DeepEqual(body["attachments"], want) || body["message"] != "Does this leave form match our policy?" {
			t.Fatalf("SendMessage %v, want attachments %v", body, want)
		}
		// Sending the same files again uploads them again (each upload is used up by its message).
		s, err = conv.Send(ctx, "And this one?", caitlyn.WithAttachments(files()[:2]...))
		if err != nil {
			t.Fatal(err)
		}
		s.Close()
		if n := len(m.matching(t, isReserve)) - reservedBefore; n != 4 {
			t.Fatalf("%d uploads over the two sends, want 4", n)
		}
		// A file that fails to upload: no message, and that file's error.
		fresh(t)
		m.faults(t, status("PutUpload", fault(503, 0), fault(503, 0), fault(503, 0)))
		if _, err := conv.Send(ctx, "Does this match?", caitlyn.WithAttachments(caitlyn.FileFromBytes("leave-policy.pdf", leavePolicy))); sdkCode(err) != "UPLOAD_PUT_FAILED" {
			t.Fatalf("got %v, want UPLOAD_PUT_FAILED", err)
		}
		if sends := m.matching(t, func(r logged) bool { return r.Method == "POST" && strings.HasSuffix(r.Path, "/messages") }); len(sends) != 0 {
			t.Fatal("a message was sent after a failed upload")
		}
	},

	"send.eager": func(t *testing.T, m mock) {
		c := client(t, m)
		s, err := c.Conversation("c-eager").Send(context.Background(), "How much leave do part-time staff get?")
		if err != nil {
			t.Fatal(err)
		}
		// Dropped unread: the message went when Send was called.
		s.Close()
		sent := m.matching(t, func(r logged) bool { return r.Method == "POST" && r.Path == "/v3/conversations/c-eager/messages" })
		if len(sent) != 1 || jsonBody(t, sent[0])["message"] != "How much leave do part-time staff get?" {
			t.Fatalf("sent %+v", sent)
		}
		// The conversation's messages show it.
		var texts []string
		for msg, err := range c.Conversation("c-eager").Messages.List(context.Background(), nil) {
			if err != nil {
				t.Fatal(err)
			}
			texts = append(texts, msg.Text)
		}
		if len(texts) == 0 || texts[0] != "How much leave do part-time staff get?" {
			t.Fatalf("messages %v", texts)
		}
	},
}

func isNotFound(err error) bool {
	var nf *caitlyn.NotFoundError
	return errors.As(err, &nf)
}

// watchServer is a knowledge base watch of its own, for the cases the mock has no fault for: each connection to
// /events is answered by the next of answers (an SSE body, or a 404 for ""), and the count of connections is kept.
func watchServer(t *testing.T, answers ...string) (*caitlyn.Client, *atomic.Int32) {
	t.Helper()
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/events") {
			http.NotFound(w, r)
			return
		}
		i := int(n.Add(1)) - 1
		if i >= len(answers) || answers[i] == "" {
			w.Header().Set("Content-Type", "application/problem+json")
			w.WriteHeader(404)
			w.Write([]byte(`{"status":404,"code":"NOT_FOUND","title":"Not found","detail":"It is gone"}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(answers[i]))
	}))
	t.Cleanup(srv.Close)
	c, err := caitlyn.NewClient("your-company.caitlyn.ai", caitlyn.Token("pat_test"), caitlyn.WithEndpoint(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	return c, &n
}

func init() {
	protocol["watch.gone"] = func(t *testing.T, _ mock) {
		snapshot := "id: s1\nevent: snapshot\ndata: {\"document\":{\"id\":\"doc-1\",\"status\":\"processing\"},\"jobs\":[],\"progress\":[]}\n\n"
		// One connection with the snapshot that then ends; every reconnect after it is a 404.
		c, n := watchServer(t, snapshot)
		w, err := c.KnowledgeBase(kb).Document("doc-1").Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		events, err := collect(w)
		if len(events) != 1 || !isNotFound(err) || n.Load() != 2 {
			t.Fatalf("events %d, err %v, %d connections; want the snapshot, then the 404 on the first reconnect", len(events), err, n.Load())
		}
		// A wait ends by the gone rule: the 404, on anything but a delete.
		c, n = watchServer(t, snapshot)
		if _, err := c.KnowledgeBase(kb).Document("doc-1").Wait(within(t)); !isNotFound(err) || n.Load() != 2 {
			t.Fatalf("wait: %v after %d connections", err, n.Load())
		}
	}
}

// progressStream is a document being processed: the snapshot (10%), two progress events (40%, 80%), the document
// indexed, then one progress event more, which a wait that has returned must never pass on.
const progressStream = "id: e1\nevent: snapshot\ndata: {\"document\":{\"id\":\"doc-1\",\"status\":\"processing\"},\"jobs\":[]," +
	"\"progress\":[{\"documentId\":\"doc-1\",\"processing\":{\"kind\":\"ingest\",\"stage\":\"pages\",\"percent\":10,\"startedAt\":\"2026-11-17T00:00:00Z\",\"updatedAt\":\"2026-11-17T00:00:00Z\"}}]}\n\n" +
	"id: e2\nevent: document.progress\ndata: {\"documentId\":\"doc-1\",\"processing\":{\"kind\":\"ingest\",\"stage\":\"passages\",\"percent\":40,\"startedAt\":\"2026-11-17T00:00:00Z\",\"updatedAt\":\"2026-11-17T00:00:01Z\"}}\n\n" +
	"id: e3\nevent: document.progress\ndata: {\"documentId\":\"doc-1\",\"processing\":{\"kind\":\"ingest\",\"stage\":\"index\",\"percent\":80,\"startedAt\":\"2026-11-17T00:00:00Z\",\"updatedAt\":\"2026-11-17T00:00:02Z\"}}\n\n" +
	"id: e4\nevent: document.updated\ndata: {\"document\":{\"id\":\"doc-1\",\"status\":\"indexed\"}}\n\n" +
	"id: e5\nevent: document.progress\ndata: {\"documentId\":\"doc-1\",\"processing\":{\"kind\":\"ingest\",\"stage\":\"index\",\"percent\":100,\"startedAt\":\"2026-11-17T00:00:00Z\",\"updatedAt\":\"2026-11-17T00:00:03Z\"}}\n\n"

// progressServer serves progressStream as the document's watch, and the document itself, indexed.
func progressServer(t *testing.T) *caitlyn.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Write([]byte(progressStream))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"doc-1","status":"indexed"}`))
	}))
	t.Cleanup(srv.Close)
	c, err := caitlyn.NewClient("your-company.caitlyn.ai", caitlyn.Token("pat_test"), caitlyn.WithEndpoint(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func init() {
	protocol["wait.progress"] = func(t *testing.T, _ mock) {
		var seen []string
		doc, err := progressServer(t).KnowledgeBase(kb).Document("doc-1").Wait(within(t), caitlyn.WithProgress(func(p caitlyn.Processing) {
			seen = append(seen, fmt.Sprintf("%s %d", *p.Stage, *p.Percent))
		}))
		if err != nil || doc.Status != caitlyn.DocumentStatusIndexed {
			t.Fatalf("waited for %+v, %v", doc, err)
		}
		// The snapshot's first, then each progress event's, once; nothing once the wait returned.
		if want := []string{"pages 10", "passages 40", "index 80"}; !reflect.DeepEqual(seen, want) {
			t.Fatalf("progress %v, want %v", seen, want)
		}
		// On the mock: a document being ingested reports its stages, its percentage never going back.
		m := fresh(t)
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0001": true}})
		var percents []int32
		if _, err := client(t, m).KnowledgeBase(kb).Document("doc-0001").Wait(within(t), caitlyn.WithProgress(func(p caitlyn.Processing) {
			if p.Document == nil {
				t.Errorf("a document's processing without its DocumentProcessing: %+v", p)
			}
			percents = append(percents, *p.Percent)
		})); err != nil {
			t.Fatal(err)
		}
		if len(percents) == 0 || !slices.IsSorted(percents) {
			t.Fatalf("percents %v", percents)
		}
	}
	protocol["watch.processing"] = func(t *testing.T, _ mock) {
		c := progressServer(t)
		w, err := c.KnowledgeBase(kb).Document("doc-1").Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		events, err := take(w, func(ev caitlyn.KnowledgeBaseEvent) bool { return ev.EventID() == "e5" })
		w.Close()
		if err != nil {
			t.Fatal(err)
		}
		// One accessor for the snapshot and the progress events alike; nothing on an event that carries none.
		var got []string
		for _, ev := range events {
			if p := ev.GetProcessing(); p != nil {
				got = append(got, fmt.Sprintf("%s %d", ev.EventType(), *p.Percent))
			} else {
				got = append(got, ev.EventType()+" none")
			}
		}
		want := []string{"snapshot 10", "document.progress 40", "document.progress 80", "document.updated none", "document.progress 100"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("processing %v, want %v", got, want)
		}
		// On the knowledge base's own watch, the accessor takes the document's identifier.
		if p := events[0].ProcessingOf("doc-1"); p == nil || *p.Percent != 10 {
			t.Fatalf("by identifier: %+v", p)
		}
		if p := events[0].ProcessingOf("doc-2"); p != nil {
			t.Fatalf("another document: %+v", p)
		}
		// A batch's or a folder's is its running job.
		var snap caitlyn.KnowledgeBaseSnapshot
		if err := json.Unmarshal([]byte(`{"folder":{"path":"/hr/"},"jobs":[{"id":"op-1","kind":"folder_change","status":"running","percent":30,"createdAt":"2026-11-17T00:00:00Z"}],"progress":[]}`), &snap); err != nil {
			t.Fatal(err)
		}
		if p := snap.GetProcessing(); p == nil || p.Job == nil || p.Job.ID != "op-1" || *p.Percent != 30 {
			t.Fatalf("a folder's: %+v", p)
		}
	}
}
