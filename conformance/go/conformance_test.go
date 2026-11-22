// Package conformance is the Go conformance harness: the protocol cases in conformance/cases/protocol.json
// (TestProtocol, one subtest per case id) and the example cases in conformance/cases/examples.json
// (TestExamples, one subtest per case), against the generated Go SDK and the mock server, plus Go-only
// cases (TestGo…). scripts/check-conformance.mjs checks that every case ran and passed. Tests run one at a
// time because they share the mock's state.
package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
	"github.com/caitlyn-ai/sdk/go/core"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const (
	kb    = "KB4T7YQ2WL"
	agent = "GHT7YRWXPL"
)

func client(t *testing.T, m mock, opts ...caitlyn.Option) *caitlyn.Client {
	t.Helper()
	c, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token("pat_test"), append([]caitlyn.Option{caitlyn.WithEndpoint(m.base)}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func listAll(ctx context.Context, c *caitlyn.Client, in *caitlyn.ListDocumentsInput) ([]caitlyn.Document, error) {
	return listIn(ctx, c, kb, in)
}

func listIn(ctx context.Context, c *caitlyn.Client, kbID string, in *caitlyn.ListDocumentsInput) ([]caitlyn.Document, error) {
	var docs []caitlyn.Document
	for d, err := range c.KnowledgeBase(kbID).Documents.List(ctx, in) {
		if err != nil {
			return docs, err
		}
		docs = append(docs, d)
	}
	return docs, nil
}

func draft(t *testing.T, c *caitlyn.Client) *caitlyn.AgentVersion {
	t.Helper()
	v, err := c.Agent(agent).Draft().Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// refusedEndpoint is an endpoint nothing listens on: a port the system handed out, then closed.
func refusedEndpoint(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return "http://" + addr
}

// apiError returns err as *caitlyn.Error, failing the test otherwise.
// An error page from something in front of the API, not a problem body (PROTOCOL.md 6.1).
const html404 = `<!DOCTYPE html><html><head><title>404: This page could not be found</title></head><body><h1>404</h1></body></html>`

// A problem body whose status disagrees with the HTTP status (PROTOCOL.md 6.3).
const mismatched409 = `{"type":"https://build.caitlyn.ai/errors/CONFLICT","title":"Conflict","status":400,"code":"CONFLICT","requestId":"01MISMATCHEDSTATUS0000000"}`

func apiError(t *testing.T, err error) *caitlyn.Error {
	t.Helper()
	var e *caitlyn.Error
	if !errors.As(err, &e) {
		t.Fatalf("want *caitlyn.Error, got %T: %v", err, err)
	}
	return e
}

// The mock's cursor the workspace stream cannot carry on from, and the cursor its stream.reset gives instead.
const (
	staleCursor = "0190d2a1-0000-7000-8000-000000000001"
	id11        = "0193a6f3-0a1b-7c2d-8e3f-000000000011"
	resetCursor = "0193a6f3-0a1b-7c2d-8e3f-000000000010"
)

func send(t *testing.T, c *caitlyn.Client, ctx context.Context, conversation string) *caitlyn.ConversationEventStream {
	t.Helper()
	s, err := c.Conversation(conversation).Send(ctx, "hi")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// connectionsLasting steps the stream clock by step at each reading, so every connection lasts exactly that long (a
// stream reads the clock when a response arrives and when its connection ends). It returns the function that puts
// the real clock back.
func connectionsLasting(step time.Duration) func() {
	real := core.StreamClock
	now := time.Unix(0, 0)
	core.StreamClock = func() time.Time {
		now = now.Add(step)
		return now
	}
	return func() { core.StreamClock = real }
}

func collect[E, F any](s *core.Stream[E, F]) ([]E, error) {
	var evs []E
	for ev, err := range s.Events() {
		if err != nil {
			return evs, err
		}
		evs = append(evs, ev)
	}
	return evs, nil
}

func eventName(ev caitlyn.ConversationEvent) string { return reflect.TypeOf(ev).Elem().Name() }

func status(op string, faults ...map[string]any) map[string]any {
	list := make([]any, len(faults))
	for i, f := range faults {
		list[i] = f
	}
	return map[string]any{"status": map[string]any{op: list}}
}

func fault(code, retryAfter int) map[string]any {
	return map[string]any{"status": code, "retryAfter": retryAfter}
}

func lastPatch(t *testing.T, m mock) (logged, map[string]any) {
	t.Helper()
	ps := m.matching(t, func(r logged) bool { return r.Method == "PATCH" })
	var body map[string]any
	json.Unmarshal([]byte(ps[len(ps)-1].Body), &body)
	return ps[len(ps)-1], body
}

// sdkVersion is the version in VERSION, which every SDK sends in its user agent.
var sdkVersion = func() string {
	b, err := os.ReadFile(filepath.Join("..", "..", "VERSION"))
	if err != nil {
		panic(err)
	}
	return strings.TrimSpace(string(b))
}()

var sdkModel = func() string {
	b, err := os.ReadFile(filepath.Join("..", "..", "model", "model.lock.json"))
	if err != nil {
		panic(err)
	}
	var lock struct {
		StampNext string `json:"stampNext"`
	}
	json.Unmarshal(b, &lock)
	return lock.StampNext
}()

// protocol is every case in conformance/cases/protocol.json, by id.
var protocol = map[string]func(t *testing.T, m mock){
	// ------------------------------------------------------------------ retries
	"retry.429-retry-after": func(t *testing.T, m mock) {
		m.faults(t, status("ListDocuments", fault(429, 2)))
		t0 := time.Now()
		docs, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](100)})
		if err != nil || len(docs) != 7 || time.Since(t0) < 2*time.Second || len(m.api(t)) != 2 {
			t.Fatalf("docs=%d err=%v after %v, %d requests", len(docs), err, time.Since(t0), len(m.api(t)))
		}
	},
	"retry.503-retry-after": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", fault(503, 1)))
		t0 := time.Now()
		if v := draft(t, client(t, m)); time.Since(t0) < time.Second || v.Name != "draft" {
			t.Fatalf("waited %v, name %q", time.Since(t0), v.Name)
		}
	},
	"retry.long-retry-after": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", fault(429, 7)))
		t0 := time.Now()
		if draft(t, client(t, m)); time.Since(t0) < 7*time.Second {
			t.Fatalf("waited %v, want ≥ 7 s", time.Since(t0))
		}
	},
	"retry.budget-drains": func(t *testing.T, m mock) {
		c := client(t, m, caitlyn.WithRetryBudget(10))
		m.faults(t, status("GetAgentVersion", fault(503, 0), fault(503, 0), fault(503, 0), fault(503, 0)))
		get := func(c *caitlyn.Client) error {
			_, err := c.Agent(agent).Draft().Get(context.Background())
			return err
		}
		var su *caitlyn.ServiceUnavailableError
		if err := get(c); !errors.As(err, &su) || len(m.api(t)) != 3 {
			t.Fatalf("first call: %v after %d requests", err, len(m.api(t)))
		}
		start := time.Now()
		if err := get(c); !errors.As(err, &su) || len(m.api(t)) != 4 || time.Since(start) > time.Second {
			t.Fatalf("second call: %v after %d requests, %v", err, len(m.api(t)), time.Since(start))
		}
		// A retry after no response costs 10: a budget of 9 pays for a 503's retry but not this one. (A transport of
		// its own: net/http resends a GET once by itself when a reused keep-alive connection closes.)
		m = fresh(t)
		m.faults(t, status("GetAgentVersion", map[string]any{"close": true}))
		var ce *caitlyn.ConnectionError
		own := caitlyn.WithHTTPClient(&http.Client{Transport: &http.Transport{}})
		if err := get(client(t, m, caitlyn.WithRetryBudget(9), own)); !errors.As(err, &ce) || len(m.api(t)) != 1 {
			t.Fatalf("no response: %v after %d requests", err, len(m.api(t)))
		}
	},
	"retry.budget-refund": func(t *testing.T, m mock) {
		c := client(t, m, caitlyn.WithRetryBudget(5))
		m.faults(t, status("GetAgentVersion", fault(503, 0)))
		draft(t, c) // retried once, then refunded
		m.faults(t, status("GetAgentVersion", fault(503, 0)))
		if v := draft(t, c); v.Name != "draft" || len(m.api(t)) != 4 {
			t.Fatalf("requests %d", len(m.api(t)))
		}
	},
	"retry.budget-first-attempt": func(t *testing.T, m mock) {
		c := client(t, m, caitlyn.WithRetryBudget(0))
		draft(t, c)
		m.faults(t, status("GetAgentVersion", fault(503, 0)))
		_, err := c.Agent(agent).Draft().Get(context.Background())
		var su *caitlyn.ServiceUnavailableError
		if !errors.As(err, &su) || len(m.api(t)) != 2 {
			t.Fatalf("%v after %d requests", err, len(m.api(t)))
		}
	},
	"retry.idempotency-key-kept": func(t *testing.T, m mock) {
		m.faults(t, status("CreateUpload", fault(503, 0), fault(429, 0)))
		path := filepath.Join(t.TempDir(), "hello.txt")
		os.WriteFile(path, []byte("hello"), 0o600)
		f, err := caitlyn.FileFromPath(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client(t, m).Core.Uploads.Send(context.Background(), f, nil); err != nil {
			t.Fatal(err)
		}
		reqs := m.matching(t, func(r logged) bool { return r.Path == "/v3/uploads" })
		k := reqs[0].Headers["idempotency-key"]
		if len(reqs) != 3 || !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(k) || reqs[1].Headers["idempotency-key"] != k || reqs[2].Headers["idempotency-key"] != k {
			t.Fatalf("keys differ or are empty: %+v", reqs)
		}
	},
	"retry.unsafe-not-retried": func(t *testing.T, m mock) {
		m.faults(t, status("SendMessage", fault(503, 0)))
		_, err := client(t, m).Conversation("c-9").Send(context.Background(), "hi")
		var unavailable *caitlyn.ServiceUnavailableError
		if !errors.As(err, &unavailable) || len(m.api(t)) != 1 {
			t.Fatalf("err %v, %d requests", err, len(m.api(t)))
		}
	},
	"retry.above-max-retry-delay": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", fault(429, 120)))
		t0 := time.Now()
		_, err := client(t, m).Agent(agent).Draft().Get(context.Background())
		var tooMany *caitlyn.TooManyRequestsError
		if !errors.As(err, &tooMany) || tooMany.Status != 429 || tooMany.RetryAfterSeconds == nil || *tooMany.RetryAfterSeconds != 120 {
			t.Fatalf("got %v", err)
		}
		if time.Since(t0) > time.Second || len(m.api(t)) != 1 {
			t.Fatalf("waited %v, %d requests", time.Since(t0), len(m.api(t)))
		}
	},

	// ------------------------------------------------------------------ pagination
	"pagination.to-last-page": func(t *testing.T, m mock) {
		docs, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](3)})
		reqs := m.api(t)
		if err != nil || len(docs) != 7 || len(reqs) != 3 || strings.Contains(reqs[0].Query, "cursor=") || !strings.Contains(reqs[2].Query, "cursor=") {
			t.Fatalf("docs=%d err=%v requests %+v", len(docs), err, reqs)
		}
	},
	"pagination.page": func(t *testing.T, m mock) {
		docs := client(t, m).KnowledgeBase(kb).Documents
		ctx := context.Background()
		first, err := docs.ListPage(ctx, &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](3)})
		if err != nil || len(first.Items) != 3 || first.NextCursor == nil || len(m.api(t)) != 1 {
			t.Fatalf("first page %+v err=%v requests %d", first, err, len(m.api(t)))
		}
		second, err := docs.ListPage(ctx, &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](3), Cursor: first.NextCursor})
		if err != nil || len(second.Items) != 3 || second.NextCursor == nil {
			t.Fatalf("second page %+v err=%v", second, err)
		}
		for _, d := range second.Items {
			for _, f := range first.Items {
				if d.ID == f.ID {
					t.Fatalf("the second page repeats %s", d.ID)
				}
			}
		}
		reqs := m.api(t)
		q, _ := url.ParseQuery(strings.TrimPrefix(reqs[1].Query, "?"))
		if len(reqs) != 2 || strings.Contains(reqs[0].Query, "cursor=") || q.Get("cursor") != *first.NextCursor {
			t.Fatalf("requests %+v", reqs)
		}
	},
	"pagination.next-page": func(t *testing.T, m mock) {
		ctx := context.Background()
		first, err := client(t, m).KnowledgeBase(kb).Documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](3)})
		if err != nil || !first.HasNextPage() {
			t.Fatalf("first %+v err=%v", first, err)
		}
		second, err := first.NextPage(ctx)
		if err != nil || second == nil || !second.HasNextPage() || len(second.Items) != 3 {
			t.Fatalf("second %+v err=%v", second, err)
		}
		third, err := second.NextPage(ctx)
		if err != nil || third == nil || third.HasNextPage() || len(third.Items) != 1 {
			t.Fatalf("third %+v err=%v", third, err)
		}
		if after, err := third.NextPage(ctx); after != nil || err != nil {
			t.Fatalf("after the last page: %+v err=%v", after, err)
		}
		reqs := m.api(t)
		q, _ := url.ParseQuery(strings.TrimPrefix(reqs[1].Query, "?"))
		if len(reqs) != 3 || q.Get("cursor") != *first.NextCursor {
			t.Fatalf("requests %+v", reqs)
		}
		for _, r := range reqs {
			if q, _ := url.ParseQuery(strings.TrimPrefix(r.Query, "?")); q.Get("limit") != "3" {
				t.Fatalf("a page without the input's limit: %+v", r)
			}
		}
	},
	"pagination.pages-from-cursor": func(t *testing.T, m mock) {
		docs := client(t, m).KnowledgeBase(kb).Documents
		ctx := context.Background()
		first, err := docs.ListPage(ctx, &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](3)})
		if err != nil {
			t.Fatal(err)
		}
		var sizes []int
		var last *caitlyn.ListDocumentsPage
		for page, err := range docs.ListPages(ctx, &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](3), Cursor: first.NextCursor}) {
			if err != nil {
				t.Fatal(err)
			}
			if last != nil && last.NextCursor == nil {
				t.Fatalf("a page followed one with no NextCursor")
			}
			sizes = append(sizes, len(page.Items))
			last = page
		}
		reqs := m.api(t)
		if len(sizes) != 2 || sizes[0] != 3 || sizes[1] != 1 || last.NextCursor != nil || len(reqs) != 3 || !strings.Contains(reqs[1].Query, "cursor=") || !strings.Contains(reqs[2].Query, "cursor=") {
			t.Fatalf("pages %v requests %+v", sizes, reqs)
		}
	},

	// ------------------------------------------------------------------ SSE
	"sse.resumed-answer-reset": func(t *testing.T, m mock) {
		// The mock cuts the stream only once the SDK has yielded the two events before the cut, so it always has an
		// event ID to resume from.
		m.faults(t, map[string]any{"dropAfterEvents": 2, "dropOnSignal": true, "finishWhileAway": true})
		stream := send(t, client(t, m), context.Background(), "c-away")
		var events []caitlyn.ConversationEvent
		var err error
		for ev, e := range stream.Events() {
			if e != nil {
				err = e
				break
			}
			events = append(events, ev)
			if len(events) == 2 {
				m.post(t, "/__mock/drop", map[string]any{})
			}
		}
		if err != nil || len(events) != 3 || events[2].EventType() != "stream.reset" {
			t.Fatalf("events %d err %v; want two events, then the reset", len(events), err)
		}
		var e *caitlyn.Error
		if _, err := stream.FinalMessage(); !errors.As(err, &e) || e.Code != "NO_FINAL_EVENT" {
			t.Fatalf("FinalMessage: %v", err)
		}
		if gets := m.matching(t, func(r logged) bool { return r.Method == "GET" }); len(gets) != 1 {
			t.Fatalf("%d reconnects; want one, and none after the reset", len(gets))
		}
	},
	"sse.watch-reconnects": func(t *testing.T, m mock) {
		c := client(t, m)
		if _, err := collect(send(t, c, context.Background(), "c-w")); err != nil {
			t.Fatal(err)
		}
		m.faults(t, map[string]any{"watchCloses": 7})
		w, err := c.Conversation("c-w").Watch(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		events, err := take(w, func(ev caitlyn.ConversationEvent) bool { return ev.EventType() == "message.completed" })
		if err != nil {
			t.Fatal(err)
		}
		var types []string
		for _, ev := range events {
			types = append(types, ev.EventType())
		}
		want := "message.started progress.updated tool.started tool.finished text.delta citation.added text.delta message.completed"
		if strings.Join(types, " ") != want {
			t.Fatalf("events %v", types)
		}
		gets := m.matching(t, func(r logged) bool { return r.Method == "GET" && r.Path == "/v3/conversations/c-w/stream" })
		if len(gets) != 8 {
			t.Fatalf("%d requests; want eight: seven reconnects, more than three, because each carried an event", len(gets))
		}
		for i, g := range gets[1:] {
			if g.Headers["last-event-id"] != events[i].EventID() {
				t.Fatalf("reconnect %d sent Last-Event-ID %q, want %q", i+1, g.Headers["last-event-id"], events[i].EventID())
			}
		}
	},
	"sse.watch-resends-request": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"watchCloses": 1})
		s, err := client(t, m).Events.Watch(context.Background(), &caitlyn.WatchWorkspaceEventsInput{
			Types: []string{"conversation.created"}, ConversationIDs: []string{"c-11", "c-12"}})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		n := 0
		events, err := take(s, func(caitlyn.WorkspaceEvent) bool { n++; return n == 2 })
		if err != nil {
			t.Fatal(err)
		}
		reqs := m.matching(t, pathHasSuffix("/v3/events/stream"))
		if len(reqs) != 2 || reqs[1].Query != reqs[0].Query || !strings.Contains(reqs[1].Query, "type=conversation.created") ||
			!strings.Contains(reqs[1].Query, "conversationId=c-11") || reqs[1].Headers["last-event-id"] != events[0].EventID() {
			t.Fatalf("requests %+v", reqs)
		}
	},
	"sse.conversation-reset": func(t *testing.T, m mock) {
		c := client(t, m)
		answer, err := collect(send(t, c, context.Background(), "c-r"))
		if err != nil {
			t.Fatal(err)
		}
		w, err := c.Conversation("c-r").Watch(context.Background(), &caitlyn.WatchConversationInput{LastEventID: caitlyn.Ptr(answer[len(answer)-1].EventID())})
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		events, err := take(w, func(ev caitlyn.ConversationEvent) bool { return ev.EventType() == "message.completed" })
		if err != nil || len(events) < 2 {
			t.Fatalf("events %d err %v", len(events), err)
		}
		reset, ok := events[0].(*caitlyn.StreamReset)
		if !ok || reset.Cursor != reset.EventID() {
			t.Fatalf("first event %#v", events[0])
		}
		if gets := m.matching(t, func(r logged) bool { return r.Method == "GET" }); len(gets) != 1 {
			t.Fatalf("%d requests; a reset is not an error and is never retried", len(gets))
		}
	},
	"sse.request-id-and-type": func(t *testing.T, m mock) {
		stream := send(t, client(t, m), context.Background(), "c-ids")
		evs, err := collect(stream)
		if err != nil {
			t.Fatal(err)
		}
		reqs := m.api(t)
		if stream.RequestID() != reqs[len(reqs)-1].RequestID {
			t.Fatalf("request id %q", stream.RequestID())
		}
		if evs[0].EventType() != "message.started" || evs[len(evs)-1].EventType() != "message.completed" {
			t.Fatalf("event types %q %q", evs[0].EventType(), evs[len(evs)-1].EventType())
		}
	},
	"sse.typed-events": func(t *testing.T, m mock) {
		stream := send(t, client(t, m), context.Background(), "c-1")
		text := ""
		var names []string
		for ev, err := range stream.Events() {
			if err != nil {
				t.Fatal(err)
			}
			names = append(names, eventName(ev))
			switch e := ev.(type) {
			case *caitlyn.TextDelta:
				text += e.Delta
			case *caitlyn.CitationAdded:
				if e.Citation.DocumentName == nil || *e.Citation.DocumentName != "leave-policy.pdf" {
					t.Fatalf("citation %+v", e.Citation)
				}
			}
		}
		want := []string{"MessageStarted", "ProgressUpdated", "ToolStarted", "ToolFinished", "TextDelta", "CitationAdded", "TextDelta", "MessageCompleted"}
		if text != "Staff receive 20 days of annual leave." || !reflect.DeepEqual(names, want) {
			t.Fatalf("text %q events %v", text, names)
		}
		answer, err := stream.FinalMessage()
		if err != nil || *answer.Citations[0].PageNumber != 3 {
			t.Fatalf("answer %+v err %v", answer, err)
		}
		if m.api(t)[0].Headers["accept"] != "text/event-stream" {
			t.Fatalf("accept %q", m.api(t)[0].Headers["accept"])
		}
	},
	"sse.resume": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"dropAfterEvents": 3})
		events, err := collect(send(t, client(t, m), context.Background(), "c-2"))
		if err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, e := range events {
			if seen[e.EventID()] {
				t.Fatalf("duplicate %s", e.EventID())
			}
			seen[e.EventID()] = true
		}
		resume := m.matching(t, func(r logged) bool { return r.Path == "/v3/conversations/c-2/stream" })
		if eventName(events[len(events)-1]) != "MessageCompleted" || len(resume) != 1 || resume[0].Headers["last-event-id"] != events[2].EventID() || resume[0].Headers["accept"] != "text/event-stream" {
			t.Fatalf("events %d resume %+v", len(events), resume)
		}
	},
	"sse.final-ends-watch": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"dropAfterEvents": 2})
		t0 := time.Now()
		answer, err := send(t, client(t, m), context.Background(), "c-watch").FinalMessage()
		if err != nil || answer.Text != "Staff receive 20 days of annual leave." {
			t.Fatalf("answer %+v err %v", answer, err)
		}
		if time.Since(t0) > 5*time.Second {
			t.Fatal("ended when the server closed the watch, not at message.completed")
		}
		for i := 0; ; i++ {
			if len(m.matching(t, func(r logged) bool { return r.Event == "client-disconnected" })) > 0 {
				break
			}
			if i == 100 {
				t.Fatal("the SDK did not close the watch connection")
			}
			time.Sleep(20 * time.Millisecond)
		}
	},
	"sse.stream-reset": func(t *testing.T, m mock) {
		s, err := client(t, m).Events.Watch(context.Background(), &caitlyn.WatchWorkspaceEventsInput{
			Types: []string{"conversation.created"}, After: caitlyn.Ptr(staleCursor)})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		n := 0
		events, err := take(s, func(caitlyn.WorkspaceEvent) bool { n++; return n == 2 }) // a watch carries on until closed
		if err != nil || len(events) != 2 {
			t.Fatalf("events %d err %v", len(events), err)
		}
		reset, ok := events[0].(*caitlyn.StreamReset)
		if !ok || reset.EventType() != "stream.reset" || reset.Cursor != resetCursor || reset.EventID() != resetCursor {
			t.Fatalf("first event %#v", events[0])
		}
		created, ok := events[1].(*caitlyn.ConversationCreatedEvent)
		if !ok || created.Data.AgentID != "GHT7YRWXPL" {
			t.Fatalf("second event %#v", events[1])
		}
		if n := len(m.api(t)); n != 1 {
			t.Fatalf("%d requests; a reset is not an error and is never retried", n)
		}
	},
	"sse.reconnect-backoff": func(t *testing.T, m mock) {
		c := client(t, m)
		if _, err := collect(send(t, c, context.Background(), "c-b")); err != nil {
			t.Fatal(err)
		}
		m.faults(t, map[string]any{"watchEmptyCloses": 4})
		w, err := c.Conversation("c-b").Watch(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		_, err = collect(w)
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "STREAM_LOST" {
			t.Fatalf("got %v, want STREAM_LOST", err)
		}
		gets := m.matching(t, func(r logged) bool { return r.Method == "GET" })
		if len(gets) != 4 {
			t.Fatalf("%d requests; want the first and three reconnects", len(gets))
		}
		g1, g2, g3 := gets[1].At-gets[0].At, gets[2].At-gets[1].At, gets[3].At-gets[2].At
		// The bands (0.25-0.5 s, 0.5-1 s, 1-2 s) do not overlap, so their lower bounds show the pause grows; the upper
		// bounds, three times each band's top, catch a broken cap.
		if g1 < 200 || g2 < 450 || g3 < 950 || g1 > 1500 || g2 > 3000 || g3 > 6000 {
			t.Fatalf("pauses %d, %d, %d ms: want at least 0.25, 0.5 and 1 s, and at most 1.5, 3 and 6 s", g1, g2, g3)
		}
	},
	"sse.reconnect-without-event-id": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"watchEmptyCloses": 1})
		s, err := client(t, m).Events.Watch(context.Background(), &caitlyn.WatchWorkspaceEventsInput{
			Types: []string{"conversation.created"}, After: caitlyn.Ptr(id11)})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		if _, err := take(s, func(caitlyn.WorkspaceEvent) bool { return true }); err != nil {
			t.Fatal(err)
		}
		reqs := m.matching(t, pathHasSuffix("/v3/events/stream"))
		if len(reqs) < 2 {
			t.Fatalf("%d requests; want a reconnect", len(reqs))
		}
		if _, sent := reqs[1].Headers["last-event-id"]; sent || reqs[1].Query != reqs[0].Query {
			t.Fatalf("reconnect %+v; want no Last-Event-ID and the same query as %q", reqs[1], reqs[0].Query)
		}
	},
	"sse.reconnect-drops-after": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"watchCloses": 1})
		s, err := client(t, m).Events.Watch(context.Background(), &caitlyn.WatchWorkspaceEventsInput{
			Types: []string{"conversation.created"}, After: caitlyn.Ptr(id11)})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		n := 0
		events, err := take(s, func(caitlyn.WorkspaceEvent) bool { n++; return n == 2 })
		if err != nil {
			t.Fatal(err)
		}
		reqs := m.matching(t, pathHasSuffix("/v3/events/stream"))
		if len(reqs) < 2 || !strings.Contains(reqs[0].Query, "after=") || strings.Contains(reqs[1].Query, "after=") ||
			!strings.Contains(reqs[1].Query, "type=conversation.created") || reqs[1].Headers["last-event-id"] != events[0].EventID() {
			t.Fatalf("requests %+v", reqs)
		}
	},
	"sse.long-connection-resets-count": func(t *testing.T, m mock) {
		c := client(t, m)
		if _, err := collect(send(t, c, context.Background(), "c-l")); err != nil {
			t.Fatal(err)
		}
		// Five quiet responses in a row (the first and four reconnects), each open just over a minute: one more than
		// the limit, so the watch carries on only because each long connection restarts the count. The sixth carries
		// events.
		m.faults(t, map[string]any{"watchEmptyCloses": 5})
		defer connectionsLasting(core.LongConnection + time.Second)()
		w, err := c.Conversation("c-l").Watch(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		var first string
		for ev, err := range w.Events() {
			if err != nil {
				t.Fatalf("got %v, want the watch to reach its events", err)
			}
			first = fmt.Sprintf("%T", ev)
			break
		}
		if !strings.Contains(first, "MessageStarted") {
			t.Fatalf("first event %s, want message.started", first)
		}
		if gets := m.matching(t, func(r logged) bool { return r.Method == "GET" }); len(gets) != 6 {
			t.Fatalf("%d requests; want the first and five reconnects", len(gets))
		}
	},
	"sse.short-connections-stream-lost": func(t *testing.T, m mock) {
		c := client(t, m)
		if _, err := collect(send(t, c, context.Background(), "c-s")); err != nil {
			t.Fatal(err)
		}
		m.faults(t, map[string]any{"watchEmptyCloses": 4})
		defer connectionsLasting(core.LongConnection - time.Second)()
		w, err := c.Conversation("c-s").Watch(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		_, err = collect(w)
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "STREAM_LOST" {
			t.Fatalf("got %v, want STREAM_LOST", err)
		}
		if gets := m.matching(t, func(r logged) bool { return r.Method == "GET" }); len(gets) != 4 {
			t.Fatalf("%d requests; want the first and three reconnects", len(gets))
		}
	},
	"sse.duplicate-not-progress": func(t *testing.T, m mock) {
		c := client(t, m)
		if _, err := collect(send(t, c, context.Background(), "c-d")); err != nil {
			t.Fatal(err)
		}
		m.faults(t, map[string]any{"watchReplayCloses": 10})
		w, err := c.Conversation("c-d").Watch(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		events, err := collect(w)
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "STREAM_LOST" || len(events) != 1 {
			t.Fatalf("events %d err %v; want one event, the duplicates dropped, then STREAM_LOST", len(events), err)
		}
		if gets := m.matching(t, func(r logged) bool { return r.Method == "GET" }); len(gets) != 4 {
			t.Fatalf("%d requests; want the first and three reconnects", len(gets))
		}
	},
	"sse.watch-failed-answer": func(t *testing.T, m mock) {
		c := client(t, m)
		m.faults(t, map[string]any{"failStream": true})
		if _, err := collect(send(t, c, context.Background(), "c-f")); err == nil {
			t.Fatal("send: want the failure raised")
		}
		w, err := c.Conversation("c-f").Watch(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		events, err := take(w, func(ev caitlyn.ConversationEvent) bool { return ev.EventType() == "message.completed" })
		if err != nil {
			t.Fatal(err)
		}
		failedAt, completedAt := -1, -1
		for i, ev := range events {
			if f, ok := ev.(*caitlyn.MessageFailed); ok {
				if f.Code != "SERVICE_UNAVAILABLE" {
					t.Fatalf("failed event %+v", f)
				}
				failedAt = i
			}
			if ev.EventType() == "message.completed" {
				completedAt = i
			}
		}
		if failedAt < 0 || completedAt < failedAt {
			t.Fatalf("message.failed at %d, message.completed at %d; want the failure delivered, then the next answer", failedAt, completedAt)
		}
	},
	"sse.clean-end-resumes": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"endAfterEvents": 2})
		events, err := collect(send(t, client(t, m), context.Background(), "c-5"))
		resume := m.matching(t, func(r logged) bool { return r.Path == "/v3/conversations/c-5/stream" })
		if err != nil || eventName(events[len(events)-1]) != "MessageCompleted" || len(resume) != 1 || resume[0].Headers["last-event-id"] != events[1].EventID() {
			t.Fatalf("err %v events %d resume %+v", err, len(events), resume)
		}
	},
	"sse.message-failed": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"failStream": true})
		events, err := collect(send(t, client(t, m), context.Background(), "c-6"))
		var unavailable *caitlyn.ServiceUnavailableError
		if !errors.As(err, &unavailable) || unavailable.Status != 503 || unavailable.Code != "SERVICE_UNAVAILABLE" || unavailable.RequestID != "01JC9Q2W7R4M0H2T6N1S8V3B80" {
			t.Fatalf("got %T %v", err, err)
		}
		if len(events) != 7 || len(m.matching(t, pathHasSuffix("/stream"))) != 0 {
			t.Fatalf("%d events before the failure; a failure is not resumed", len(events))
		}
	},

	// ------------------------------------------------------------------ tolerance
	"tolerance.unknown-event": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"unknownEvent": true})
		events, err := collect(send(t, client(t, m), context.Background(), "c-3"))
		if err != nil || len(events) != 8 || eventName(events[7]) != "MessageCompleted" {
			t.Fatalf("events %d err %v", len(events), err)
		}
	},
	"tolerance.unknown-enum": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"unknownEnum": true})
		docs, err := listAll(context.Background(), client(t, m), nil)
		if err != nil || docs[1].Status != "archived" || docs[1].Status.Known() {
			t.Fatalf("status %q err %v", docs[1].Status, err)
		}
		if v := draft(t, client(t, m)); v.Source == nil || *v.Source != "cloned_from_template" {
			t.Fatalf("source %v", v.Source)
		}
	},
	"tolerance.unknown-error-code": func(t *testing.T, m mock) {
		body := `{"type":"https://build.caitlyn.ai/errors/SOMETHING_NEW","title":"Something new","status":409,"code":"SOMETHING_NEW","requestId":"r-1"}`
		m.faults(t, map[string]any{"status": map[string]any{"GetAgentVersion": []any{map[string]any{"status": 409, "contentType": "application/problem+json", "body": body}}}})
		_, err := client(t, m).Agent(agent).Draft().Get(context.Background())
		var conflict *caitlyn.ConflictError
		if !errors.As(err, &conflict) || conflict.Status != 409 || conflict.Code != "SOMETHING_NEW" {
			t.Fatalf("response: got %T %v", err, err)
		}
		m.post(t, "/__mock/reset", nil)
		m.faults(t, map[string]any{"busyDocuments": map[string]any{"doc-0002": true}, "jobOutcomes": map[string]any{"doc-0002": "failed"},
			"jobError": map[string]any{"code": "SOMETHING_NEW", "detail": "A failure this SDK does not know."}})
		_, err = client(t, m).KnowledgeBase(kb).Document("doc-0002").Wait(within(t))
		var generic *caitlyn.Error
		if errors.As(err, &conflict) || !errors.As(err, &generic) || generic.Status != 0 || generic.Code != "SOMETHING_NEW" {
			t.Fatalf("job: got %T %v", err, err)
		}
	},
	"tolerance.unknown-field-raw": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"unknownField": true})
		c := client(t, m)
		v := draft(t, c)
		raw := v.Raw()
		if !reflect.DeepEqual(raw["reviewState"], map[string]any{"required": false}) {
			t.Fatalf("reviewState %v", raw["reviewState"])
		}
		// One type per thing: the body is the thing, its etag a member of it like any other
		if raw["etag"] != v.ETag {
			t.Fatalf("raw etag %v, ETag %q", raw["etag"], v.ETag)
		}
		answer, err := send(t, c, context.Background(), "c-6").FinalMessage()
		if err != nil || answer.Raw()["sentiment"] != "neutral" {
			t.Fatalf("final raw %v err %v", answer.Raw(), err)
		}
	},
	"tolerance.nested-raw": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"unknownField": true})
		c := client(t, m)
		docs, err := listAll(context.Background(), c, nil)
		if err != nil || !reflect.DeepEqual(docs[0].Raw()["retentionPolicy"], map[string]any{"keepDays": 365.0}) {
			t.Fatalf("item raw %v err %v", docs[0].Raw(), err)
		}
		if kbs := draft(t, c).Configuration.KnowledgeBases; kbs[0].Raw()["reranker"] != "cohere" {
			t.Fatalf("nested raw %v", kbs[0].Raw())
		}
	},

	// ------------------------------------------------------------------ typed errors
	"errors.404": func(t *testing.T, _ mock) {
		for _, header := range []bool{false, true} {
			m := fresh(t)
			m.faults(t, map[string]any{"awsErrorTypeHeader": header})
			_, err := listIn(context.Background(), client(t, m), "NOPE", nil)
			var nf *caitlyn.NotFoundError
			reqs := m.api(t)
			if !errors.As(err, &nf) || nf.Status != 404 || nf.Code != "NOT_FOUND" || nf.RequestID != reqs[len(reqs)-1].RequestID || nf.Type != "https://build.caitlyn.ai/errors/NOT_FOUND" {
				t.Fatalf("X-Amzn-Errortype %v: got %T %v", header, err, err)
			}
		}
	},
	"errors.409": func(t *testing.T, m mock) {
		c := client(t, m)
		up, err := c.Core.Uploads.Reserve(context.Background(), &caitlyn.CreateUploadInput{FileName: "a.pdf", ContentType: "application/pdf", ByteSize: 1, SHA256: "x"})
		if err != nil {
			t.Fatal(err)
		}
		_, err = c.KnowledgeBase(kb).Documents.Create(context.Background(), caitlyn.UploadID(up.ID), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
		var conflict *caitlyn.ConflictError
		if !errors.As(err, &conflict) || conflict.Code != caitlyn.ErrorCodeConflict {
			t.Fatalf("got %v", err)
		}
	},
	"errors.versions-not-numbered": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"versionsNotNumbered": map[string]any{"doc-0001": true}})
		doc := client(t, m).KnowledgeBase(kb).Document("doc-0001")
		_, err := doc.Version("1").Delete(context.Background())
		var conflict *caitlyn.ConflictError
		if !errors.As(err, &conflict) || conflict.Status != 409 || conflict.Code != caitlyn.ErrorCodeVersionsNotNumbered {
			t.Fatalf("got %T %v", err, err)
		}
		if n := len(m.matching(t, func(r logged) bool { return r.Method == "DELETE" })); n != 1 {
			t.Fatalf("%d DELETEs, want 1 (not retried)", n)
		}
		if d, err := doc.Get(context.Background()); err != nil || d.VersionCount == nil || *d.VersionCount != 1 {
			t.Fatalf("after: %+v, %v", d, err)
		}
	},
	"errors.412": func(t *testing.T, m mock) {
		c := client(t, m)
		d := draft(t, c)
		if _, err := c.Agent(agent).Draft().Update(context.Background(), &caitlyn.UpdateDraftVersionInput{Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr("first")}}, caitlyn.WithIfMatch(d.ETag)); err != nil {
			t.Fatal(err)
		}
		_, err := c.Agent(agent).Draft().Update(context.Background(), &caitlyn.UpdateDraftVersionInput{Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr("second")}}, caitlyn.WithIfMatch(d.ETag))
		var pf *caitlyn.PreconditionFailedError
		if !errors.As(err, &pf) || pf.Code != "PRECONDITION_FAILED" || pf.RequestID == "" {
			t.Fatalf("got %v", err)
		}
	},
	"errors.429-exhausted": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", fault(429, 0), fault(429, 0), fault(429, 0)))
		_, err := client(t, m).Agent(agent).Draft().Get(context.Background())
		if e := apiError(t, err); e.Status != 429 || e.Code != "RATE_LIMITED" || e.RetryAfterSeconds == nil || *e.RetryAfterSeconds != 0 || len(m.api(t)) != 3 {
			t.Fatalf("got %+v", e)
		}
	},
	"errors.html-404": func(t *testing.T, m mock) {
		m.faults(t, status("ListDocuments", map[string]any{"status": 404, "contentType": "text/html; charset=utf-8", "body": html404}))
		_, err := listAll(context.Background(), client(t, m), nil)
		var nf *caitlyn.NotFoundError
		if !errors.As(err, &nf) || nf.Status != 404 || nf.Code != "HTTP_404" || nf.RequestID != "" || nf.RawBody != html404 {
			t.Fatalf("got %T %+v", err, err)
		}
	},
	"errors.empty-405": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", map[string]any{"status": 405, "body": ""}))
		_, err := client(t, m).Agent(agent).Draft().Get(context.Background())
		e, ok := err.(*caitlyn.Error)
		if !ok || e.Status != 405 || e.Code != "HTTP_405" || e.RequestID != "" || e.RawBody != "" {
			t.Fatalf("got %T %+v", err, err)
		}
	},
	"errors.text-502": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", map[string]any{"status": 502, "contentType": "text/plain", "body": "Bad Gateway"}))
		_, err := client(t, m).Agent(agent).Draft().Get(context.Background())
		e, ok := err.(*caitlyn.Error)
		if !ok || e.Status != 502 || e.Code != "HTTP_502" || e.RawBody != "Bad Gateway" || len(m.api(t)) != 1 {
			t.Fatalf("got %T %+v", err, err)
		}
	},
	"errors.status-from-http": func(t *testing.T, m mock) {
		m.faults(t, status("CreateUpload", map[string]any{"status": 409, "contentType": "application/problem+json", "body": mismatched409}))
		_, err := client(t, m).Core.Uploads.Reserve(context.Background(), &caitlyn.CreateUploadInput{FileName: "a.txt", ContentType: "text/plain", ByteSize: 1, SHA256: "x"})
		var conflict *caitlyn.ConflictError
		if !errors.As(err, &conflict) || conflict.Status != 409 || conflict.Code != "CONFLICT" || conflict.RequestID != "01MISMATCHEDSTATUS0000000" {
			t.Fatalf("got %T %+v", err, err)
		}
	},
	"errors.field-errors": func(t *testing.T, m mock) {
		c := client(t, m)
		d := draft(t, c)
		_, err := c.Agent(agent).Draft().Update(context.Background(), &caitlyn.UpdateDraftVersionInput{Guidance: &caitlyn.AgentGuidance{Identity: caitlyn.Ptr("x")}, Clear: []caitlyn.ClearableDraftField{caitlyn.ClearableDraftFieldGuidanceIdentity}}, caitlyn.WithIfMatch(d.ETag))
		var ve *caitlyn.ValidationError
		if !errors.As(err, &ve) || ve.Code != "VALIDATION_FAILED" || len(ve.Errors) != 1 || ve.Errors[0].Pointer != "/guidance/identity" || ve.Errors[0].Code != "VALIDATION_FAILED" {
			t.Fatalf("got %v", err)
		}
		if _, body := lastPatch(t, m); !reflect.DeepEqual(body, map[string]any{"guidance": map[string]any{"identity": "x"}, "clear": []any{"guidance.identity"}}) {
			t.Fatalf("body %v", body)
		}
	},

	"errors.unmodelled-status": func(t *testing.T, m mock) {
		m.faults(t, status("CreateUpload", map[string]any{"status": 404}, map[string]any{"status": 405, "body": ""}))
		c := client(t, m)
		reserve := func() error {
			_, err := c.Core.Uploads.Reserve(context.Background(), &caitlyn.CreateUploadInput{FileName: "a.txt", ContentType: "text/plain", ByteSize: 1, SHA256: "x"})
			return err
		}
		var nf *caitlyn.NotFoundError
		if err := reserve(); !errors.As(err, &nf) || nf.Status != 404 || nf.Code != "HTTP_404" {
			t.Fatalf("404: %T %v", err, err)
		}
		err := reserve()
		var ae *caitlyn.Error
		if errors.As(err, &nf) || !errors.As(err, &ae) || ae.Status != 405 || ae.Code != "HTTP_405" || core.ErrorType(err) != "CaitlynError" {
			t.Fatalf("405: %T %v", err, err)
		}
	},
	"errors.raw-body-limit": func(t *testing.T, m mock) {
		page := "<!DOCTYPE html>" + strings.Repeat("x", 20480-15)
		straddle := strings.Repeat("a", 8191) + strings.Repeat("€", 10)
		html := func(body string) map[string]any {
			return map[string]any{"status": 404, "contentType": "text/html", "body": body}
		}
		m.faults(t, status("GetAgentVersion", html(page), html(straddle)))
		c := client(t, m)
		get := func(version string) *caitlyn.NotFoundError {
			t.Helper()
			_, err := c.Agent(agent).Version(version).Get(context.Background())
			var nf *caitlyn.NotFoundError
			if !errors.As(err, &nf) {
				t.Fatalf("got %T %v", err, err)
			}
			return nf
		}
		if e := get("draft"); len(e.RawBody) != 8192 || e.RawBody != page[:8192] || !e.RawBodyTruncated {
			t.Fatalf("page: %d bytes, truncated %v", len(e.RawBody), e.RawBodyTruncated)
		}
		if e := get("draft"); e.RawBody != strings.Repeat("a", 8191) || !e.RawBodyTruncated {
			t.Fatalf("straddle: %d bytes, truncated %v", len(e.RawBody), e.RawBodyTruncated)
		}
		e := get("nope")
		var body map[string]any
		if json.Unmarshal([]byte(e.RawBody), &body) != nil || body["code"] != "NOT_FOUND" || e.RawBodyTruncated {
			t.Fatalf("problem: %q truncated %v", e.RawBody, e.RawBodyTruncated)
		}
	},
	"errors.connection": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", map[string]any{"close": true}))
		// A transport of its own: net/http resends a GET once by itself when a reused keep-alive connection closes.
		own := caitlyn.WithHTTPClient(&http.Client{Transport: &http.Transport{}})
		_, closed := client(t, m, caitlyn.WithMaxAttempts(1), own).Agent(agent).Draft().Get(context.Background())
		_, refused := client(t, m, caitlyn.WithMaxAttempts(1), caitlyn.WithEndpoint(refusedEndpoint(t))).Agent(agent).Draft().Get(context.Background())
		for _, err := range []error{closed, refused} {
			var ce *caitlyn.ConnectionError
			var ae *caitlyn.Error
			if !errors.As(err, &ce) || !errors.As(err, &ae) {
				t.Fatalf("not a connection error: %T %v", err, err)
			}
			if ce.Status != 0 || ce.Code != "CONNECTION_ERROR" || ce.RequestID != "" || ce.RawBody != "" || ce.RawBodyTruncated || ce.Cause == nil {
				t.Fatalf("connection error %+v", ce.APIError)
			}
			if !strings.Contains(err.Error(), "GetAgentVersion") {
				t.Fatalf("message %q", err.Error())
			}
		}
		var op *net.OpError
		if !errors.As(refused, &op) || !errors.Is(refused, syscall.ECONNREFUSED) {
			t.Fatalf("the cause of a refused connection is %v", errors.Unwrap(errors.Unwrap(refused)))
		}
		if n := len(m.api(t)); n != 1 {
			t.Fatalf("requests=%d", n)
		}
	},

	// ------------------------------------------------------------------ cancellation
	"cancel.stream": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"streamDelayMs": 150})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		stream := send(t, client(t, m), ctx, "c-4")
		n := 0
		var last error
		for _, err := range stream.Events() {
			if err != nil {
				last = err
				break
			}
			if n++; n == 2 {
				cancel()
			}
		}
		if !errors.Is(last, context.Canceled) {
			t.Fatalf("want context.Canceled, got %v", last)
		}
		time.Sleep(300 * time.Millisecond)
		if len(m.matching(t, func(r logged) bool { return r.Event == "client-disconnected" })) == 0 {
			t.Fatal("the mock saw no disconnect")
		}
	},
	"cancel.unary": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", fault(503, 2)))
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(200*time.Millisecond, cancel)
		t0 := time.Now()
		_, err := client(t, m).Agent(agent).Draft().Get(ctx)
		if !errors.Is(err, context.Canceled) || time.Since(t0) > time.Second {
			t.Fatalf("err %v after %v", err, time.Since(t0))
		}
	},

	// ------------------------------------------------------------------ updates
	"update.if-match": func(t *testing.T, m mock) {
		c := client(t, m)
		d := draft(t, c)
		updated, err := c.Agent(agent).Draft().Update(context.Background(), &caitlyn.UpdateDraftVersionInput{Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr("x")}}, caitlyn.WithIfMatch(d.ETag))
		if err != nil {
			t.Fatal(err)
		}
		if updated.ETag == d.ETag {
			t.Fatalf("etag %q unchanged", updated.ETag)
		}
		if p, body := lastPatch(t, m); p.Headers["if-match"] != d.ETag || !reflect.DeepEqual(body, map[string]any{"guidance": map[string]any{"instructions": "x"}}) {
			t.Fatalf("patch %+v", p)
		}
	},
	"update.clear": func(t *testing.T, m mock) {
		c := client(t, m)
		d := draft(t, c)
		updated, err := c.Agent(agent).Draft().Update(context.Background(), &caitlyn.UpdateDraftVersionInput{Clear: []caitlyn.ClearableDraftField{caitlyn.ClearableDraftFieldGuidanceIdentity}}, caitlyn.WithIfMatch(d.ETag))
		if err != nil || updated.Configuration.Guidance == nil || updated.Configuration.Guidance.Identity != nil || deref(updated.Configuration.Guidance.Instructions) != "Answer from the HR policies." {
			t.Fatalf("updated %+v err %v", updated, err)
		}
		if _, body := lastPatch(t, m); !reflect.DeepEqual(body, map[string]any{"clear": []any{"guidance.identity"}}) {
			t.Fatalf("body %v", body)
		}
	},

	// ------------------------------------------------------------------ wire and environment
	"wire.headers": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", fault(503, 0)))
		draft(t, client(t, m))
		sent := m.api(t)
		if len(sent) != 2 {
			t.Fatalf("requests=%d", len(sent))
		}
		ua := regexp.MustCompile(`^caitlyn-sdk-go/` + regexp.QuoteMeta(sdkVersion) + ` lang/go#1\.\d+(\.\d+)? md/gc os/[a-z]+$`)
		for _, r := range sent {
			for _, h := range r.HeaderNames {
				if strings.HasPrefix(h, "x-amz") || strings.HasPrefix(h, "amz-sdk") || strings.HasPrefix(h, "x-amzn") {
					t.Fatalf("AWS header sent: %s", h)
				}
			}
			if !ua.MatchString(r.Headers["user-agent"]) {
				t.Fatalf("user agent %q", r.Headers["user-agent"])
			}
			if r.Headers["caitlyn-sdk-model"] != sdkModel || r.Headers["caitlyn-api-version"] != "" || r.Headers["authorization"] != "Bearer pat_test" ||
				r.Headers["content-type"] != "" || r.Headers["traceparent"] != "" {
				t.Fatalf("headers %v", r.Headers)
			}
		}
	},
	"environment.hostile-aws": func(t *testing.T, m mock) {
		hostile := "max_attempts = 1\nretry_mode = adaptive\ndefaults_mode = auto\nendpoint_url = http://127.0.0.1:9\nregion = xx-hostile-1\n"
		cfg := filepath.Join(t.TempDir(), "config")
		os.WriteFile(cfg, []byte("[profile hostile]\n"+hostile+"\n[default]\n"+hostile), 0o600)
		for k, v := range map[string]string{
			"AWS_PROFILE": "hostile", "AWS_REGION": "xx-hostile-1", "AWS_MAX_ATTEMPTS": "1", "AWS_RETRY_MODE": "adaptive",
			"AWS_DEFAULTS_MODE": "auto", "AWS_ENDPOINT_URL": "http://127.0.0.1:9", "AWS_CONFIG_FILE": cfg,
			"AWS_SHARED_CREDENTIALS_FILE": cfg, "AWS_EC2_METADATA_SERVICE_ENDPOINT": "http://10.255.255.1",
		} {
			t.Setenv(k, v)
		}
		m.faults(t, status("GetAgentVersion", fault(503, 0)))
		t0 := time.Now()
		v := draft(t, client(t, m))
		docs, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](3)})
		if v.Name != "draft" || len(docs) != 7 || err != nil || time.Since(t0) > 2*time.Second {
			t.Fatalf("name %q docs %d err %v after %v", v.Name, len(docs), err, time.Since(t0))
		}
		if n := len(m.matching(t, pathContains("/versions/"))); n != 2 {
			t.Fatalf("AWS_MAX_ATTEMPTS=1 was not ignored: %d requests", n)
		}
	},

	// ------------------------------------------------------------------ versions, headers, telemetry, endpoint
	"since.fails-before-sending": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"apiVersion": "5.110.0"})
		c := client(t, m)
		draft(t, c) // no check before the first response
		before := len(m.api(t))
		_, err := c.Agent(agent).Draft().Get(context.Background())
		var ns *caitlyn.NotSupportedByServerError
		if !errors.As(err, &ns) || ns.Operation != "GetAgentVersion" || ns.Requires != sdkModel || ns.Server != "5.110.0" || len(m.api(t)) != before {
			t.Fatalf("got %v", err)
		}
	},
	"since.unknown-operation": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"status": map[string]any{"GetAgentVersion": []any{
			map[string]any{"status": 404, "code": "UNKNOWN_OPERATION"},
			map[string]any{"status": 405, "code": "METHOD_NOT_ALLOWED"},
			map[string]any{"status": 404, "code": "NOT_FOUND"},
		}}})
		c := client(t, m)
		for i, answer := range []string{"404 UNKNOWN_OPERATION", "405 METHOD_NOT_ALLOWED"} {
			_, err := c.Agent(agent).Draft().Get(context.Background())
			var ns *caitlyn.NotSupportedByServerError
			if !errors.As(err, &ns) || ns.Operation != "GetAgentVersion" || ns.Requires != sdkModel || ns.Server != "5.120.0" || len(m.api(t)) != i+1 {
				t.Fatalf("%s: got %T %v, %d requests", answer, err, err, len(m.api(t)))
			}
		}
		_, err := c.Agent(agent).Draft().Get(context.Background())
		var ns *caitlyn.NotSupportedByServerError
		if e := apiError(t, err); errors.As(err, &ns) || e.Status != 404 || e.Code != "NOT_FOUND" {
			t.Fatalf("NOT_FOUND: got %T %v", err, err)
		}
	},
	"headers.request-id": func(t *testing.T, m mock) {
		// A result that is not a thing has both as members; a thing has them in its ResponseMetadata
		c := client(t, m)
		me, err := c.Me(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		reqs := m.api(t)
		if me.RequestID == nil || *me.RequestID != reqs[len(reqs)-1].RequestID || me.APIVersion == nil || *me.APIVersion != "5.120.0" {
			t.Fatalf("request id %v api version %v", me.RequestID, me.APIVersion)
		}
		v := draft(t, c)
		reqs = m.api(t)
		if md := v.ResponseMetadata(); md.RequestID != reqs[len(reqs)-1].RequestID || md.APIVersion != "5.120.0" {
			t.Fatalf("thing's metadata %+v", md)
		}
	},
	"headers.response-metadata": func(t *testing.T, m mock) {
		v := draft(t, client(t, m))
		reqs := m.api(t)
		md := v.ResponseMetadata()
		if md.HTTPStatusCode != 200 || md.RequestID != reqs[len(reqs)-1].RequestID || md.APIVersion != "5.120.0" || v.ETag != `"draft-1"` {
			t.Fatalf("metadata %+v", md)
		}
		if (&caitlyn.AgentVersion{}).ResponseMetadata() != (caitlyn.ResponseMetadata{}) {
			t.Fatal("a result built in code has metadata")
		}
	},
	"telemetry.attributes": func(t *testing.T, m mock) {
		exporter := tracetest.NewInMemoryExporter()
		c := client(t, m, caitlyn.WithTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))))
		m.faults(t, status("GetAgentVersion", fault(503, 0)))
		if _, err := c.Agent(agent).Version("nope").Get(context.Background()); err == nil {
			t.Fatal("no error")
		}
		if _, err := listAll(context.Background(), c, &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr(int32(100))}); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "hello.txt")
		os.WriteFile(path, []byte("hello"), 0o600)
		f, _ := caitlyn.FileFromPath(path)
		if _, err := c.Core.Uploads.Send(context.Background(), f, nil); err != nil {
			t.Fatal(err)
		}
		spans := exporter.GetSpans()
		attrs := func(s tracetest.SpanStub) map[string]any {
			out := map[string]any{}
			for _, a := range s.Attributes {
				out[string(a.Key)] = a.Value.AsInterface()
			}
			return out
		}
		children := func(p tracetest.SpanStub) []tracetest.SpanStub {
			var out []tracetest.SpanStub
			for _, s := range spans {
				if s.Parent.SpanID() == p.SpanContext.SpanID() {
					out = append(out, s)
				}
			}
			return out
		}
		find := func(name, method string) tracetest.SpanStub {
			for _, s := range spans {
				if s.Name == name && (method == "" || attrs(s)["rpc.method"] == method) {
					return s
				}
			}
			t.Fatalf("no %s %s span", name, method)
			return tracetest.SpanStub{}
		}
		for _, s := range spans {
			if s.Name != "caitlyn.call" && s.Name != "caitlyn.attempt" && s.Name != "caitlyn.upload" {
				t.Fatalf("span %q", s.Name)
			}
			if _, ok := attrs(s)["caitlyn.operation"]; ok {
				t.Fatalf("caitlyn.operation on %s", s.Name)
			}
		}
		var sent []logged
		for _, r := range m.api(t) {
			if r.Path == "/v3/agents/"+agent+"/versions/nope" {
				sent = append(sent, r)
			}
		}
		call := find("caitlyn.call", "GetAgentVersion")
		a := attrs(call)
		if a["rpc.system"] != "caitlyn" || a["error.type"] != "NotFoundError" || a["caitlyn.error.code"] != "NOT_FOUND" ||
			a["caitlyn.request_id"] != sent[len(sent)-1].RequestID || call.Status.Code != codes.Error {
			t.Fatalf("call span %v status %v", a, call.Status)
		}
		exceptionType := func(s tracetest.SpanStub) any {
			for _, e := range s.Events {
				if e.Name == "exception" {
					for _, a := range e.Attributes {
						if a.Key == "exception.type" {
							return a.Value.AsInterface()
						}
					}
				}
			}
			return nil
		}
		if exceptionType(call) != "NotFoundError" || call.Status.Description == "" {
			t.Fatalf("call exception %v status %q", exceptionType(call), call.Status.Description)
		}
		attempts := children(call)
		if len(attempts) != 2 {
			t.Fatalf("attempts %d", len(attempts))
		}
		for i, s := range attempts {
			a := attrs(s)
			want := map[string]any{
				"http.request.method": "GET", "server.address": "127.0.0.1", "url.full": m.base + "/v3/agents/" + agent + "/versions/nope",
				"http.request.resend_count": int64(i), "http.response.status_code": int64([]int{503, 404}[i]),
				"caitlyn.request_id": sent[i].RequestID, "caitlyn.server.api_version": "5.120.0",
			}
			for k, v := range want {
				if a[k] != v {
					t.Fatalf("attempt %d %s = %v, want %v", i, k, a[k], v)
				}
			}
			if s.Name != "caitlyn.attempt" || s.Status.Code != codes.Error || s.Status.Description == "" {
				t.Fatalf("attempt %d %s status %v", i, s.Name, s.Status)
			}
			wantType, wantCode := []string{"ServiceUnavailableError", "NotFoundError"}[i], []string{"SERVICE_UNAVAILABLE", "NOT_FOUND"}[i]
			if a["error.type"] != wantType || a["caitlyn.error.code"] != wantCode || exceptionType(s) != wantType {
				t.Fatalf("attempt %d error.type %v code %v exception %v", i, a["error.type"], a["caitlyn.error.code"], exceptionType(s))
			}
		}
		list := children(find("caitlyn.call", "ListDocuments"))
		if len(list) != 1 || attrs(list[0])["url.full"] != m.base+"/v3/knowledge-bases/"+kb+"/documents" || list[0].Status.Code == codes.Error {
			t.Fatalf("list attempts %v", list)
		}
		up := attrs(find("caitlyn.upload", ""))
		if up["http.request.method"] != "PUT" || up["server.address"] != "127.0.0.1" || up["http.response.status_code"] != int64(200) ||
			!regexp.MustCompile(`^http://127\.0\.0\.1:\d+/__s3/[^?]+$`).MatchString(fmt.Sprint(up["url.full"])) {
			t.Fatalf("upload span %v", up)
		}
	},
	"telemetry.spans": func(t *testing.T, m mock) {
		exporter := tracetest.NewInMemoryExporter()
		tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
		m.faults(t, status("GetAgentVersion", fault(503, 0)))
		draft(t, client(t, m, caitlyn.WithTracerProvider(tp), caitlyn.WithPropagator(propagation.TraceContext{})))
		spans := exporter.GetSpans()
		var call *tracetest.SpanStub
		for i := range spans {
			if spans[i].Name == "caitlyn.call" {
				call = &spans[i]
			}
		}
		if call == nil {
			t.Fatalf("no call span in %d spans", len(spans))
		}
		var resends []int64
		for _, s := range spans {
			if s.Parent.SpanID() == call.SpanContext.SpanID() {
				for _, a := range s.Attributes {
					if a.Key == "http.request.resend_count" {
						resends = append(resends, a.Value.AsInt64())
					}
				}
			}
		}
		reqs := m.api(t)
		requestID := ""
		for _, a := range call.Attributes {
			if a.Key == "caitlyn.request_id" {
				requestID = a.Value.AsString()
			}
		}
		if !reflect.DeepEqual(resends, []int64{0, 1}) || requestID != reqs[len(reqs)-1].RequestID {
			t.Fatalf("attempt spans %v request id %q", resends, requestID)
		}
		for _, r := range reqs {
			if r.Headers["traceparent"] == "" {
				t.Fatal("no traceparent")
			}
		}
	},
	"endpoint.workspace-url": func(t *testing.T, m mock) {
		for _, w := range []string{"https://your-company.getcaitlyn.ai", "https://your-company.getcaitlyn.ai/", "your-company.getcaitlyn.ai/", "HTTPS://Your-Company.GetCaitlyn.ai"} {
			c, err := caitlyn.NewClient(w, caitlyn.Token("pat_test"))
			if err != nil || c.Endpoint() != "https://your-company.getcaitlyn.ai/api" || c.Auth().TokenEndpoint() != "https://your-company.getcaitlyn.ai/api/oauth/token" {
				t.Fatalf("%q: endpoint %v, err %v", w, c, err)
			}
		}
		for _, w := range []string{"https://your-company.getcaitlyn.ai/api", "https://your-company.getcaitlyn.ai/?x=1", "https://your-company.getcaitlyn.ai#top", "http://your-company.getcaitlyn.ai", "ftp://your-company.getcaitlyn.ai", "me@your-company.getcaitlyn.ai", ""} {
			if _, err := caitlyn.NewClient(w, caitlyn.Token("pat_test")); err == nil || !strings.Contains(err.Error(), "your-company.getcaitlyn.ai or https://your-company.getcaitlyn.ai") {
				t.Fatalf("%q: err %v", w, err)
			}
		}
	},
	"endpoint.workspace": func(t *testing.T, m mock) {
		c, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token("pat_test"))
		if err != nil || c.Endpoint() != "https://your-company.getcaitlyn.ai/api" {
			t.Fatalf("endpoint %q err %v", c.Endpoint(), err)
		}
	},
}

func TestProtocol(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(root, "conformance", "cases", "protocol.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalogue struct {
		Cases []struct {
			ID string `json:"id"`
		} `json:"cases"`
	}
	json.Unmarshal(b, &catalogue)
	for _, c := range catalogue.Cases {
		run, ok := protocol[c.ID]
		t.Run(c.ID, func(t *testing.T) {
			if !ok {
				t.Fatalf("no Go test for protocol case %s", c.ID)
			}
			// A case that runs past caseTimeout fails here, in seconds, rather than holding the suite until go test's
			// own timeout: the case's goroutine is left behind, and the run ends with the failure.
			done := make(chan struct{})
			go func() {
				defer close(done)
				run(t, fresh(t))
			}()
			select {
			case <-done:
			case <-time.After(caseTimeout):
				t.Fatalf("protocol case %s ran past %s", c.ID, caseTimeout)
			}
		})
	}
}

// caseTimeout is the longest a protocol case may run; the slowest takes about 14 s.
const caseTimeout = 60 * time.Second

// ------------------------------------------------------------------ the model's @examples

type exampleCase struct {
	ID        string          `json:"id"`
	Operation string          `json:"operation"`
	Input     json.RawMessage `json:"input"`
	Expected  struct {
		Output json.RawMessage `json:"output"`
		Error  *struct {
			Status    int    `json:"status"`
			Code      string `json:"code"`
			Shape     string `json:"shape"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	} `json:"expected"`
}

func decode[T any](t *testing.T, raw json.RawMessage) *T {
	t.Helper()
	v := new(T)
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
	return v
}

// drain opens a stream and closes it: an example checks the request, which the mock has seen once the stream's
// response arrived, or the error the request got. (The mock answers a stream example with a conversation's events,
// which another operation's stream, such as WatchIngestionBatch, skips as unknown.)
func drain[E, F any](s *core.Stream[E, F], err error) (any, error) {
	if err != nil {
		return nil, err
	}
	s.Close()
	return nil, nil
}

// take reads events until stop returns true for one, or the stream ends.
func take[E, F any](s *core.Stream[E, F], stop func(E) bool) ([]E, error) {
	var evs []E
	for ev, err := range s.Events() {
		if err != nil {
			return evs, err
		}
		evs = append(evs, ev)
		if stop(ev) {
			break
		}
	}
	return evs, nil
}

// fill decodes an example's input into an operation's Input type: body members by their json tags, and HTTP-bound
// members (json:"-" on the Input type) by their member name. It returns the example's idempotency key and If-Match
// as call options.
func fill[I any](t *testing.T, raw json.RawMessage) (*I, []caitlyn.CallOption) {
	t.Helper()
	in := decode[I](t, raw)
	var members map[string]json.RawMessage
	if err := json.Unmarshal(raw, &members); err != nil {
		t.Fatal(err)
	}
	v := reflect.ValueOf(in).Elem()
	for i := 0; i < v.NumField(); i++ {
		f := v.Type().Field(i)
		if !f.IsExported() || f.Tag.Get("json") != "-" {
			continue
		}
		for name, value := range members {
			if strings.EqualFold(name, f.Name) {
				p := reflect.New(f.Type)
				if err := json.Unmarshal(value, p.Interface()); err != nil {
					t.Fatalf("%s: %v", name, err)
				}
				v.Field(i).Set(p.Elem())
			}
		}
	}
	var opts []caitlyn.CallOption
	if k := member(t, members, "idempotencyKey"); k != "" {
		opts = append(opts, caitlyn.WithIdempotencyKey(k))
	}
	if m := member(t, members, "ifMatch"); m != "" {
		opts = append(opts, caitlyn.WithIfMatch(m))
	}
	return in, opts
}

// member is a string member of an example's input, or "".
func member(t *testing.T, members map[string]json.RawMessage, name string) string {
	t.Helper()
	var s string
	if raw, ok := members[name]; ok {
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	return s
}

// str is a string member of an example's input: an identifier for the scope, or a leading argument.
func str(t *testing.T, raw json.RawMessage, name string) string {
	t.Helper()
	var members map[string]json.RawMessage
	json.Unmarshal(raw, &members)
	return member(t, members, name)
}

// has reports whether an example's input names a member.
func has(raw json.RawMessage, name string) bool {
	var members map[string]json.RawMessage
	json.Unmarshal(raw, &members)
	_, ok := members[name]
	return ok
}

// result returns a call's output, or only its error (never a nil pointer inside an interface). A create's scope and a
// started call's handle embed the response, which is what an example's output describes.
func result[O any](out *O, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return response(out), nil
}

// response is a Created… or …Started handle's Result (PROTOCOL.md 16), or v itself.
func response(v any) any {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Pointer || rv.IsNil() || rv.Elem().Kind() != reflect.Struct {
		return v
	}
	typ := rv.Elem().Type()
	if !strings.HasPrefix(typ.Name(), "Created") && !strings.HasSuffix(typ.Name(), "Started") {
		return v
	}
	if f := rv.Elem().FieldByName("Result"); f.IsValid() {
		return f.Interface()
	}
	return v
}

func call[I, O any](t *testing.T, raw json.RawMessage, fn func(context.Context, *I, ...caitlyn.CallOption) (*O, error)) (any, error) {
	in, opts := fill[I](t, raw)
	return result(fn(context.Background(), in, opts...))
}

// call0 calls a method that takes nothing but its scope's identifiers.
func call0[O any](t *testing.T, raw json.RawMessage, fn func(context.Context, ...caitlyn.CallOption) (*O, error)) (any, error) {
	_, opts := fill[struct{}](t, raw)
	return result(fn(context.Background(), opts...))
}

// callFile calls a method that takes a file in place of an upload's id: the example's upload id, as an UploadID.
func callFile[I, O any](t *testing.T, raw json.RawMessage, member string, fn func(context.Context, caitlyn.File, *I, ...caitlyn.CallOption) (*O, error)) (any, error) {
	in, opts := fill[I](t, raw)
	return result(fn(context.Background(), caitlyn.UploadID(str(t, raw, member)), in, opts...))
}

// estimateFile is a file of the example's described name, content type, size and hints (the first of a list): what a
// file job's estimate takes.
func estimateFile(t *testing.T, raw json.RawMessage, member string) caitlyn.File {
	var members map[string]json.RawMessage
	json.Unmarshal(raw, &members)
	d := members[member]
	if len(d) > 0 && d[0] == '[' {
		var list []json.RawMessage
		json.Unmarshal(d, &list)
		d = list[0]
	}
	desc := decode[caitlyn.UploadDescription](t, d)
	fopts := []caitlyn.FileOption{caitlyn.WithContentType(desc.ContentType)}
	if desc.Hints != nil {
		fopts = append(fopts, caitlyn.WithHints(desc.Hints))
	}
	return caitlyn.FileFromBytes(desc.Name, make([]byte, desc.ByteSize), fopts...)
}

// callEstimate calls a file job's estimate: the file, and the estimate's own input.
func callEstimate[I, O any](t *testing.T, raw json.RawMessage, member string, fn func(context.Context, caitlyn.File, *I, ...caitlyn.CallOption) (*O, error)) (any, error) {
	in, opts := fill[I](t, raw)
	return result(fn(context.Background(), estimateFile(t, raw, member), in, opts...))
}

// callEstimate0 calls a file job's estimate that takes nothing but the file.
func callEstimate0[O any](t *testing.T, raw json.RawMessage, member string, fn func(context.Context, caitlyn.File, ...caitlyn.CallOption) (*O, error)) (any, error) {
	_, opts := fill[struct{}](t, raw)
	return result(fn(context.Background(), estimateFile(t, raw, member), opts...))
}

// callLead2 calls a building block that takes two identifiers as leading arguments.
func callLead2[I, O any](t *testing.T, raw json.RawMessage, a, b string, fn func(context.Context, string, string, *I, ...caitlyn.CallOption) (*O, error)) (any, error) {
	in, opts := fill[I](t, raw)
	return result(fn(context.Background(), str(t, raw, a), str(t, raw, b), in, opts...))
}

func callLead2NoInput[O any](t *testing.T, raw json.RawMessage, a, b string, fn func(context.Context, string, string, ...caitlyn.CallOption) (*O, error)) (any, error) {
	_, opts := fill[struct{}](t, raw)
	return result(fn(context.Background(), str(t, raw, a), str(t, raw, b), opts...))
}

// firstPage reads a list's page with its ...Page method (PROTOCOL.md 10): every example is one page.
func firstPage[I, P any](t *testing.T, raw json.RawMessage, fn func(context.Context, *I, ...caitlyn.CallOption) (*P, error)) (any, error) {
	in, opts := fill[I](t, raw)
	return result(fn(context.Background(), in, opts...))
}

func firstPageLead[I, P any](t *testing.T, raw json.RawMessage, a string, fn func(context.Context, string, *I, ...caitlyn.CallOption) (*P, error)) (any, error) {
	in, opts := fill[I](t, raw)
	return result(fn(context.Background(), str(t, raw, a), in, opts...))
}

func firstEvent[I, E, F any](t *testing.T, raw json.RawMessage, fn func(context.Context, *I, ...caitlyn.CallOption) (*core.Stream[E, F], error)) (any, error) {
	in, opts := fill[I](t, raw)
	return drain(fn(context.Background(), in, opts...))
}

func firstEvent0[E, F any](t *testing.T, raw json.RawMessage, fn func(context.Context, ...caitlyn.CallOption) (*core.Stream[E, F], error)) (any, error) {
	_, opts := fill[struct{}](t, raw)
	return drain(fn(context.Background(), opts...))
}

// examples calls each operation with an example's input, through the scope tree (conformance/cases/scope-tree.json):
// the example's identifiers make the scope, and the rest is the call's input. A new operation in the model fails
// TestExamples until it has an entry here.
var examples = map[string]func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error){
	"BatchCreateIngestionBatchItems": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return callLead2(t, in, "knowledgeBaseId", "ingestionBatchId", c.Core.Ingestion.AddItems)
	},
	"BatchDeleteDocuments": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Documents.DeleteMany)
	},
	"CancelDocumentProcessing": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).CancelProcessing)
	},
	"CancelIngestionBatch": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "ingestionBatchId")).Cancel)
	},
	"CancelIngestionBatchItem": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "ingestionBatchId")).Item(str(t, in, "itemId")).Cancel)
	},
	"CancelOperation": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Core.Operation(str(t, in, "knowledgeBaseId"), str(t, in, "operationId")).Cancel)
	},
	"CompareAgentVersions": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agent(str(t, in, "agentId")).Version(str(t, in, "version")).Compare)
	},
	"CompleteIngestionBatchUploads": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return callLead2(t, in, "knowledgeBaseId", "ingestionBatchId", c.Core.Ingestion.CompleteUploads)
	},
	"CreateAgent": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agents.Create)
	},
	"CreateConversation": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agent(str(t, in, "agentId")).Version(str(t, in, "version")).Conversations.Create)
	},
	"CreateDocument": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return callFile(t, in, "uploadId", c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Documents.Create)
	},
	"CreateDocumentVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return callFile(t, in, "uploadId", c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Replace)
	},
	"CreateField": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Fields.Create)
	},
	"CreateFolder": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Folders.Create)
	},
	"CreateIngestionBatch": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batches.Create)
	},
	"CreateIngestionBatchUploadPolicy": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return callLead2NoInput(t, in, "knowledgeBaseId", "ingestionBatchId", c.Core.Ingestion.UploadPolicy)
	},
	"CreateKnowledgeBase": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBases.Create)
	},
	"CreateUpload": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Core.Uploads.Reserve)
	},
	"DeleteAgent": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Agent(str(t, in, "agentId")).Delete)
	},
	"DeleteAgentVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Agent(str(t, in, "agentId")).Version(str(t, in, "version")).Delete)
	},
	"DeleteDocument": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Delete)
	},
	"DeleteDocumentVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Version(str(t, in, "version")).Delete)
	},
	"DeleteField": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Field(str(t, in, "fieldKey")).Delete)
	},
	"DeleteFolder": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Folder(str(t, in, "folderPath")).Delete)
	},
	"DeleteKnowledgeBase": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Delete)
	},
	"EnableLayoutAwareSearch": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).LayoutAwareSearch.Enable)
	},
	"EstimateDocumentVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return callEstimate(t, in, "file", c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).EstimateReplace)
	},
	"EstimateFillInFields": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Fields.EstimateFillIn)
	},
	"EstimateIngestion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return callEstimate0(t, in, "documents", c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Documents.EstimateCreate)
	},
	"EstimateLayoutAwareSearch": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).LayoutAwareSearch.EstimateEnable)
	},
	"EstimateReprocessDocuments": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Documents.EstimateReprocess)
	},
	"FillInFields": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Fields.FillIn)
	},
	"GetAccess": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		switch {
		case has(in, "knowledgeBaseId") && has(in, "document"):
			return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "document")).Access.Get)
		case has(in, "knowledgeBaseId") && has(in, "folder"):
			return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Folder(str(t, in, "folder")).Access.Get)
		default:
			return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Access.Get)
		}
	},
	"GetAgent": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Agent(str(t, in, "agentId")).Get)
	},
	"GetAgentVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Agent(str(t, in, "agentId")).Version(str(t, in, "version")).Get)
	},
	"GetCaller": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Me)
	},
	"GetConversation": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Conversation(str(t, in, "conversationId")).Get)
	},
	"GetDocument": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Get)
	},
	"GetDocumentContent": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return callLead2(t, in, "knowledgeBaseId", "documentId", c.Core.Documents.Content)
	},
	"GetDocumentDownload": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Download)
	},
	"GetDocumentVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Version(str(t, in, "version")).Get)
	},
	"GetField": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Field(str(t, in, "fieldKey")).Get)
	},
	"GetHistoryEntry": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Agent(str(t, in, "agentId")).HistoryEntry(str(t, in, "historyEntryId")).Get)
	},
	"GetIngestionBatch": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "ingestionBatchId")).Get)
	},
	"GetIngestionBatchItem": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "ingestionBatchId")).Item(str(t, in, "itemId")).Get)
	},
	"GetKnowledgeBase": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Get)
	},
	"GetOperation": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Core.Operation(str(t, in, "knowledgeBaseId"), str(t, in, "operationId")).Get)
	},
	"GetUpload": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.Core.Upload(str(t, in, "uploadId")).Get)
	},
	"ListAgentVersions": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agent(str(t, in, "agentId")).Versions.ListPage)
	},
	"ListAgents": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agents.ListPage)
	},
	"ListConversations": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agent(str(t, in, "agentId")).Conversations.ListPage)
	},
	"ListDocumentVersions": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Versions.ListPage)
	},
	"ListDocuments": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Documents.ListPage)
	},
	"ListFields": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Fields.ListPage)
	},
	"ListFolders": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Folders.ListPage)
	},
	"ListGuardrails": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agents.Options.GuardrailsPage)
	},
	"ListHistoryEntries": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agent(str(t, in, "agentId")).History.ListPage)
	},
	"ListIngestionBatchItems": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "ingestionBatchId")).Items.ListPage)
	},
	"ListIngestionBatches": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batches.ListPage)
	},
	"ListKnowledgeBases": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.KnowledgeBases.ListPage)
	},
	"ListMemoryStores": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agents.Options.MemoryStoresPage)
	},
	"ListMessages": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Conversation(str(t, in, "conversationId")).Messages.ListPage)
	},
	"ListModels": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agents.Options.ModelsPage)
	},
	"ListOperations": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPageLead(t, in, "knowledgeBaseId", c.Core.Operations.ListPage)
	},
	"ListTools": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agents.Options.ToolsPage)
	},
	"ListVoices": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstPage(t, in, c.Agents.Options.VoicesPage)
	},
	"PublishAgentVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agent(str(t, in, "agentId")).Version(str(t, in, "version")).Publish)
	},
	"PutAccess": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		switch {
		case has(in, "knowledgeBaseId") && has(in, "document"):
			return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "document")).Access.Set)
		case has(in, "knowledgeBaseId") && has(in, "folder"):
			return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Folder(str(t, in, "folder")).Access.Set)
		default:
			return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Access.Set)
		}
	},
	"ReplaceDraftVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agent(str(t, in, "agentId")).Draft().Replace)
	},
	"ReprocessDocuments": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Documents.Reprocess)
	},
	"ResetDraftVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agent(str(t, in, "agentId")).Draft().Reset)
	},
	"RetryDocument": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Retry)
	},
	"SaveDraftVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agent(str(t, in, "agentId")).Draft().Save)
	},
	"SendMessage": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return sendExample(t, c, in)
	},
	"StartIngestionBatch": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "ingestionBatchId")).Start)
	},
	"UpdateAgent": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agent(str(t, in, "agentId")).Update)
	},
	"UpdateDocument": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "documentId")).Update)
	},
	"UpdateDraftVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.Agent(str(t, in, "agentId")).Draft().Update)
	},
	"UpdateField": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Field(str(t, in, "fieldKey")).Update)
	},
	"UpdateFolder": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Folder(str(t, in, "folderPath")).Update)
	},
	"UpdateIngestionBatch": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "ingestionBatchId")).Update)
	},
	"UpdateIngestionBatchItem": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "ingestionBatchId")).Item(str(t, in, "itemId")).Resolve)
	},
	"UpdateKnowledgeBase": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return call(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Update)
	},
	"WatchConversation": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstEvent(t, in, c.Conversation(str(t, in, "conversationId")).Watch)
	},
	"WatchKnowledgeBase": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		switch {
		case has(in, "knowledgeBaseId") && has(in, "document"):
			return firstEvent0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Document(str(t, in, "document")).Watch)
		case has(in, "knowledgeBaseId") && has(in, "folder"):
			return firstEvent0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Folder(str(t, in, "folder")).Watch)
		case has(in, "knowledgeBaseId") && has(in, "batch"):
			return firstEvent0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Ingestion.Batch(str(t, in, "batch")).Watch)
		default:
			return firstEvent0(t, in, c.KnowledgeBase(str(t, in, "knowledgeBaseId")).Watch)
		}
	},
	"WatchOperation": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstEvent(t, in, c.Core.Operation(str(t, in, "knowledgeBaseId"), str(t, in, "operationId")).Watch)
	},
	"WatchWorkspaceEvents": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		return firstEvent(t, in, c.Events.Watch)
	},
}

// sendExample calls Conversation(id).Send with an example's message, its context and its attachments' upload ids.
func sendExample(t *testing.T, c *caitlyn.Client, raw json.RawMessage) (any, error) {
	in := decode[caitlyn.SendMessageInput](t, raw)
	opts := []caitlyn.SendOption{caitlyn.WithMessageContext(in.Context...)}
	for _, a := range in.Attachments {
		opts = append(opts, caitlyn.WithAttachments(caitlyn.UploadID(a.UploadID)))
	}
	return drain(c.Conversation(str(t, raw, "conversationId")).Send(context.Background(), in.Message, opts...))
}

// assertSubset checks every member of the expected JSON against the output's fields, found by their
// json tags, or for header-bound members (json:"-") by name; timestamps compare as instants.
func assertSubset(t *testing.T, expected any, actual reflect.Value, at string) {
	t.Helper()
	for actual.Kind() == reflect.Pointer || actual.Kind() == reflect.Interface {
		if actual.IsNil() {
			t.Fatalf("%s: expected %v, got nil", at, expected)
		}
		actual = actual.Elem()
	}
	if ts, ok := actual.Interface().(time.Time); ok {
		want, err := time.Parse(time.RFC3339Nano, expected.(string))
		if err != nil || !ts.Equal(want) {
			t.Fatalf("%s: expected %v, got %v", at, expected, ts)
		}
		return
	}
	switch e := expected.(type) {
	case map[string]any:
		if actual.Kind() == reflect.Map {
			for k, v := range e {
				// Keys may be a named string type (map[IngestionItemOutcome]int64).
				got := actual.MapIndex(reflect.ValueOf(k).Convert(actual.Type().Key()))
				if !got.IsValid() {
					t.Fatalf("%s: no key %q", at, k)
				}
				assertSubset(t, v, got, at+"."+k)
			}
			return
		}
		for k, v := range e {
			f, ok := fieldFor(actual.Type(), k)
			if !ok {
				t.Fatalf("%s: no field for %q", at, k)
			}
			assertSubset(t, v, actual.FieldByIndex(f.Index), at+"."+k)
		}
	case []any:
		if actual.Len() != len(e) {
			t.Fatalf("%s: expected %d items, got %d", at, len(e), actual.Len())
		}
		for i, v := range e {
			assertSubset(t, v, actual.Index(i), at+"["+string(rune('0'+i))+"]")
		}
	default:
		got := actual.Interface()
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(expected)
		if string(gotJSON) != string(wantJSON) {
			t.Fatalf("%s: expected %s, got %s", at, wantJSON, gotJSON)
		}
	}
}

func fieldFor(typ reflect.Type, member string) (reflect.StructField, bool) {
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if name := strings.Split(f.Tag.Get("json"), ",")[0]; name == member {
			return f, true
		}
	}
	// Header-bound members have json:"-": match the Go field name (etag -> ETag, location -> Location).
	for i := 0; i < typ.NumField(); i++ {
		if f := typ.Field(i); f.IsExported() && strings.EqualFold(f.Name, member) {
			return f, true
		}
	}
	return reflect.StructField{}, false
}

func TestExamples(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(root, "conformance", "cases", "examples.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []exampleCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	for _, ex := range file.Cases {
		t.Run(ex.ID, func(t *testing.T) {
			m := fresh(t)
			call, ok := examples[ex.Operation]
			if !ok {
				t.Fatalf("no example entry for %s", ex.Operation)
			}
			m.primeExample(t, ex.ID)
			out, err := call(t, client(t, m), ex.Input)
			res := m.exampleResult(t)
			if !res.Served || len(res.Mismatches) != 0 {
				t.Fatalf("served %v, request differs from the example: %v", res.Served, res.Mismatches)
			}
			if want := ex.Expected.Error; want != nil {
				e := apiError(t, err)
				typed := reflect.TypeOf(err).Elem().Name()
				if typed != want.Shape || e.Status != want.Status || e.Code != want.Code || e.RequestID != want.RequestID {
					t.Fatalf("got %s %+v, want %+v", typed, e, want)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error %v", err)
			}
			if len(ex.Expected.Output) > 0 && string(ex.Expected.Output) != "null" {
				var expected any
				json.Unmarshal(ex.Expected.Output, &expected)
				assertSubset(t, expected, reflect.ValueOf(out), "output")
			}
		})
	}
}

// ------------------------------------------------------------------ Go only

// TestGoTypedErrorAlsoMatchesError: errors.As works with the typed error and with *caitlyn.Error.
func TestGoTypedErrorAlsoMatchesError(t *testing.T) {
	m := fresh(t)
	_, err := client(t, m).Agent(agent).Version("v99").Get(context.Background())
	var nf *caitlyn.NotFoundError
	var e *caitlyn.Error
	if !errors.As(err, &nf) || !errors.As(err, &e) || e.Status != 404 {
		t.Fatalf("got %T %v", err, err)
	}
}

// TestGoFinalMessageAfterBreak: FinalMessage drains the rest of the stream after the caller stops ranging.
func TestGoFinalMessageAfterBreak(t *testing.T) {
	m := fresh(t)
	stream := send(t, client(t, m), context.Background(), "c-7")
	for range stream.Events() {
		break
	}
	answer, err := stream.FinalMessage()
	if err != nil || answer.Text != "Staff receive 20 days of annual leave." {
		t.Fatalf("answer %v err %v", answer, err)
	}
}

// TestGoIfMatchRequiredBeforeSending: a replace without WithIfMatch fails before anything is sent (the draft's update
// takes If-Match as an option, its replace still needs it).
func TestGoIfMatchRequiredBeforeSending(t *testing.T) {
	m := fresh(t)
	// ResetDraftVersion is not @ifMatchOptional: without WithIfMatch it fails before anything is sent
	_, err := client(t, m).Agent(agent).Draft().Reset(context.Background(), &caitlyn.ResetDraftVersionInput{From: "live"})
	var ie *caitlyn.InputError
	if !errors.As(err, &ie) || len(m.api(t)) != 0 {
		t.Fatalf("got %v", err)
	}
}

// TestGoStreamIsIncremental: events arrive as they are sent rather than after the stream ends (the
// Python suite's synchronous-client case; Go has one, blocking, client).
func TestGoStreamIsIncremental(t *testing.T) {
	m := fresh(t)
	m.faults(t, map[string]any{"streamDelayMs": 100})
	t0 := time.Now()
	stream := send(t, client(t, m), context.Background(), "c-5")
	var firstAt time.Duration
	for _, err := range stream.Events() {
		if err != nil {
			t.Fatal(err)
		}
		if firstAt == 0 {
			firstAt = time.Since(t0)
		}
	}
	if answer, err := stream.FinalMessage(); err != nil || answer.Text != "Staff receive 20 days of annual leave." || firstAt > 500*time.Millisecond {
		t.Fatalf("answer %v err %v, first event after %v", answer, err, firstAt)
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
