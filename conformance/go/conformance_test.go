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
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/caitlyn-ai/caitlyn-go"
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
	var docs []caitlyn.Document
	for d, err := range c.Documents.List(ctx, in) {
		if err != nil {
			return docs, err
		}
		docs = append(docs, d)
	}
	return docs, nil
}

func draft(t *testing.T, c *caitlyn.Client) *caitlyn.AgentVersion {
	t.Helper()
	v, err := c.Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
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

func send(t *testing.T, c *caitlyn.Client, ctx context.Context, conversation string) *caitlyn.ConversationEventStream {
	t.Helper()
	s, err := c.Conversations.Send(ctx, conversation, &caitlyn.SendMessageInput{Message: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func collect(s *caitlyn.ConversationEventStream) ([]caitlyn.ConversationEvent, error) {
	var evs []caitlyn.ConversationEvent
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
		docs, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{KnowledgeBaseID: kb, Limit: caitlyn.Ptr[int32](100)})
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
	"retry.idempotency-key-kept": func(t *testing.T, m mock) {
		m.faults(t, status("CreateUpload", fault(503, 0), fault(429, 0)))
		path := filepath.Join(t.TempDir(), "hello.txt")
		os.WriteFile(path, []byte("hello"), 0o600)
		f, err := caitlyn.FileFromPath(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client(t, m).Uploads.Create(context.Background(), f); err != nil {
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
		_, err := client(t, m).Conversations.Send(context.Background(), "c-9", &caitlyn.SendMessageInput{Message: "hi"})
		var unavailable *caitlyn.ServiceUnavailableError
		if !errors.As(err, &unavailable) || len(m.api(t)) != 1 {
			t.Fatalf("err %v, %d requests", err, len(m.api(t)))
		}
	},
	"retry.above-max-retry-delay": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", fault(429, 120)))
		t0 := time.Now()
		_, err := client(t, m).Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
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
		docs, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{KnowledgeBaseID: kb, Limit: caitlyn.Ptr[int32](3)})
		reqs := m.api(t)
		if err != nil || len(docs) != 7 || len(reqs) != 3 || strings.Contains(reqs[0].Query, "cursor=") || !strings.Contains(reqs[2].Query, "cursor=") {
			t.Fatalf("docs=%d err=%v requests %+v", len(docs), err, reqs)
		}
	},

	// ------------------------------------------------------------------ SSE
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
		docs, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{KnowledgeBaseID: kb})
		if err != nil || docs[1].Status != "archived" || docs[1].Status.Known() {
			t.Fatalf("status %q err %v", docs[1].Status, err)
		}
		if v := draft(t, client(t, m)); v.Source == nil || *v.Source != "cloned_from_template" {
			t.Fatalf("source %v", v.Source)
		}
	},
	"tolerance.unknown-field-raw": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"unknownField": true})
		c := client(t, m)
		raw := draft(t, c).Raw()
		if !reflect.DeepEqual(raw["reviewState"], map[string]any{"required": false}) {
			t.Fatalf("reviewState %v", raw["reviewState"])
		}
		if _, ok := raw["etag"]; ok {
			t.Fatal("raw holds the header-bound etag")
		}
		answer, err := send(t, c, context.Background(), "c-6").FinalMessage()
		if err != nil || answer.Raw()["sentiment"] != "neutral" {
			t.Fatalf("final raw %v err %v", answer.Raw(), err)
		}
	},
	"tolerance.nested-raw": func(t *testing.T, m mock) {
		m.faults(t, map[string]any{"unknownField": true})
		c := client(t, m)
		docs, err := listAll(context.Background(), c, &caitlyn.ListDocumentsInput{KnowledgeBaseID: kb})
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
			_, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{KnowledgeBaseID: "NOPE"})
			var nf *caitlyn.NotFoundError
			reqs := m.api(t)
			if !errors.As(err, &nf) || nf.Status != 404 || nf.Code != "NOT_FOUND" || nf.RequestID != reqs[len(reqs)-1].RequestID || nf.Type != "https://build.caitlyn.ai/errors/NOT_FOUND" {
				t.Fatalf("X-Amzn-Errortype %v: got %T %v", header, err, err)
			}
		}
	},
	"errors.409": func(t *testing.T, m mock) {
		c := client(t, m)
		up, err := c.Uploads.Reserve(context.Background(), &caitlyn.CreateUploadInput{FileName: "a.txt", ContentType: "text/plain", ByteSize: 1, SHA256: "x"})
		if err != nil {
			t.Fatal(err)
		}
		_, err = c.Documents.Create(context.Background(), &caitlyn.CreateDocumentInput{KnowledgeBaseID: kb, UploadID: up.ID, Folder: "hr/"})
		var conflict *caitlyn.ConflictError
		if !errors.As(err, &conflict) || conflict.Code != "CONFLICT" {
			t.Fatalf("got %v", err)
		}
	},
	"errors.412": func(t *testing.T, m mock) {
		c := client(t, m)
		d := draft(t, c)
		if _, err := c.Versions.UpdateDraft(context.Background(), agent, &caitlyn.UpdateDraftVersionInput{Instructions: caitlyn.Ptr("first")}, caitlyn.WithIfMatch(d.ETag)); err != nil {
			t.Fatal(err)
		}
		_, err := c.Versions.UpdateDraft(context.Background(), agent, &caitlyn.UpdateDraftVersionInput{Instructions: caitlyn.Ptr("second")}, caitlyn.WithIfMatch(d.ETag))
		var pf *caitlyn.PreconditionFailedError
		if !errors.As(err, &pf) || pf.Code != "PRECONDITION_FAILED" || pf.RequestID == "" {
			t.Fatalf("got %v", err)
		}
	},
	"errors.429-exhausted": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", fault(429, 0), fault(429, 0), fault(429, 0)))
		_, err := client(t, m).Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
		if e := apiError(t, err); e.Status != 429 || e.Code != "RATE_LIMITED" || e.RetryAfterSeconds == nil || *e.RetryAfterSeconds != 0 || len(m.api(t)) != 3 {
			t.Fatalf("got %+v", e)
		}
	},
	"errors.html-404": func(t *testing.T, m mock) {
		m.faults(t, status("ListDocuments", map[string]any{"status": 404, "contentType": "text/html; charset=utf-8", "body": html404}))
		_, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{KnowledgeBaseID: kb})
		var nf *caitlyn.NotFoundError
		if !errors.As(err, &nf) || nf.Status != 404 || nf.Code != "HTTP_404" || nf.RequestID != "" || nf.RawBody != html404 {
			t.Fatalf("got %T %+v", err, err)
		}
	},
	"errors.empty-405": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", map[string]any{"status": 405, "body": ""}))
		_, err := client(t, m).Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
		e, ok := err.(*caitlyn.Error)
		if !ok || e.Status != 405 || e.Code != "HTTP_405" || e.RequestID != "" || e.RawBody != "" {
			t.Fatalf("got %T %+v", err, err)
		}
	},
	"errors.text-502": func(t *testing.T, m mock) {
		m.faults(t, status("GetAgentVersion", map[string]any{"status": 502, "contentType": "text/plain", "body": "Bad Gateway"}))
		_, err := client(t, m).Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
		e, ok := err.(*caitlyn.Error)
		if !ok || e.Status != 502 || e.Code != "HTTP_502" || e.RawBody != "Bad Gateway" || len(m.api(t)) != 1 {
			t.Fatalf("got %T %+v", err, err)
		}
	},
	"errors.status-from-http": func(t *testing.T, m mock) {
		m.faults(t, status("CreateUpload", map[string]any{"status": 409, "contentType": "application/problem+json", "body": mismatched409}))
		_, err := client(t, m).Uploads.Reserve(context.Background(), &caitlyn.CreateUploadInput{FileName: "a.txt", ContentType: "text/plain", ByteSize: 1, SHA256: "x"})
		var conflict *caitlyn.ConflictError
		if !errors.As(err, &conflict) || conflict.Status != 409 || conflict.Code != "CONFLICT" || conflict.RequestID != "01MISMATCHEDSTATUS0000000" {
			t.Fatalf("got %T %+v", err, err)
		}
	},
	"errors.field-errors": func(t *testing.T, m mock) {
		c := client(t, m)
		d := draft(t, c)
		_, err := c.Versions.UpdateDraft(context.Background(), agent, &caitlyn.UpdateDraftVersionInput{Identity: caitlyn.Ptr("x"), Clear: []caitlyn.ClearableDraftField{"identity"}}, caitlyn.WithIfMatch(d.ETag))
		var ve *caitlyn.ValidationError
		if !errors.As(err, &ve) || ve.Code != "VALIDATION_FAILED" || len(ve.Errors) != 1 || ve.Errors[0].Pointer != "/identity" || ve.Errors[0].Code != "VALIDATION_FAILED" {
			t.Fatalf("got %v", err)
		}
		if _, body := lastPatch(t, m); !reflect.DeepEqual(body, map[string]any{"identity": "x", "clear": []any{"identity"}}) {
			t.Fatalf("body %v", body)
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
			_, err := c.Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: version})
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
		_, closed := client(t, m, caitlyn.WithMaxAttempts(1), own).Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
		_, refused := client(t, m, caitlyn.WithMaxAttempts(1), caitlyn.WithEndpoint(refusedEndpoint(t))).Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
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
		_, err := client(t, m).Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
		if !errors.Is(err, context.Canceled) || time.Since(t0) > time.Second {
			t.Fatalf("err %v after %v", err, time.Since(t0))
		}
	},

	// ------------------------------------------------------------------ updates
	"update.if-match": func(t *testing.T, m mock) {
		c := client(t, m)
		d := draft(t, c)
		updated, err := c.Versions.UpdateDraft(context.Background(), agent, &caitlyn.UpdateDraftVersionInput{Instructions: caitlyn.Ptr("x")}, caitlyn.WithIfMatch(d.ETag))
		if err != nil || updated.ETag == d.ETag {
			t.Fatalf("etag %q err %v", updated.ETag, err)
		}
		if p, body := lastPatch(t, m); p.Headers["if-match"] != d.ETag || !reflect.DeepEqual(body, map[string]any{"instructions": "x"}) {
			t.Fatalf("patch %+v", p)
		}
	},
	"update.clear": func(t *testing.T, m mock) {
		c := client(t, m)
		d := draft(t, c)
		updated, err := c.Versions.UpdateDraft(context.Background(), agent, &caitlyn.UpdateDraftVersionInput{Clear: []caitlyn.ClearableDraftField{"identity"}}, caitlyn.WithIfMatch(d.ETag))
		if err != nil || updated.Configuration.Identity != nil || updated.Configuration.Instructions != "Answer from the HR policies." {
			t.Fatalf("updated %+v err %v", updated, err)
		}
		if _, body := lastPatch(t, m); !reflect.DeepEqual(body, map[string]any{"clear": []any{"identity"}}) {
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
		docs, err := listAll(context.Background(), client(t, m), &caitlyn.ListDocumentsInput{KnowledgeBaseID: kb, Limit: caitlyn.Ptr[int32](3)})
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
		_, err := c.Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
		var ns *caitlyn.NotSupportedByServerError
		if !errors.As(err, &ns) || ns.Operation != "GetAgentVersion" || ns.Requires != sdkModel || ns.Server != "5.110.0" || len(m.api(t)) != before {
			t.Fatalf("got %v", err)
		}
	},
	"headers.request-id": func(t *testing.T, m mock) {
		v := draft(t, client(t, m))
		reqs := m.api(t)
		if v.RequestID == nil || *v.RequestID != reqs[len(reqs)-1].RequestID || v.APIVersion == nil || *v.APIVersion != "5.120.0" {
			t.Fatalf("request id %v api version %v", v.RequestID, v.APIVersion)
		}
	},
	"headers.response-metadata": func(t *testing.T, m mock) {
		v := draft(t, client(t, m))
		reqs := m.api(t)
		md := v.ResponseMetadata()
		if md.HTTPStatusCode != 200 || md.RequestID != reqs[len(reqs)-1].RequestID || md.ETag != `"draft-1"` || md.ETag != v.ETag {
			t.Fatalf("metadata %+v", md)
		}
		if (&caitlyn.AgentVersion{}).ResponseMetadata() != (caitlyn.ResponseMetadata{}) {
			t.Fatal("a result built in code has metadata")
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
			if spans[i].Name == "caitlyn GetAgentVersion" {
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
			run(t, fresh(t))
		})
	}
}

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

// labels holds the HTTP-bound members of an example's input (the generated Input types keep only body
// members in their JSON form).
type labels struct {
	KnowledgeBaseID string                  `json:"knowledgeBaseId"`
	ConversationID  string                  `json:"conversationId"`
	AgentID         string                  `json:"agentId"`
	Version         string                  `json:"version"`
	IdempotencyKey  string                  `json:"idempotencyKey"`
	IfMatch         string                  `json:"ifMatch"`
	LastEventID     *string                 `json:"lastEventId"`
	Limit           *int32                  `json:"limit"`
	Cursor          *string                 `json:"cursor"`
	Sort            *string                 `json:"sort"`
	Folder          *string                 `json:"folder"`
	Status          *caitlyn.DocumentStatus `json:"status"`
	NamePrefix      *string                 `json:"namePrefix"`
}

func decode[T any](t *testing.T, raw json.RawMessage) *T {
	t.Helper()
	v := new(T)
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
	return v
}

// callOptions turns the example's idempotency key and If-Match into call options.
func (l labels) callOptions() []caitlyn.CallOption {
	var opts []caitlyn.CallOption
	if l.IdempotencyKey != "" {
		opts = append(opts, caitlyn.WithIdempotencyKey(l.IdempotencyKey))
	}
	if l.IfMatch != "" {
		opts = append(opts, caitlyn.WithIfMatch(l.IfMatch))
	}
	return opts
}

func drain(s *caitlyn.ConversationEventStream, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	defer s.Close()
	_, err = collect(s)
	return nil, err
}

// examples calls each operation with an example's input. A new operation in the model fails TestExamples
// until it has an entry here.
var examples = map[string]func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error){
	"CreateDocument": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		l, body := decode[labels](t, in), decode[caitlyn.CreateDocumentInput](t, in)
		body.KnowledgeBaseID = l.KnowledgeBaseID
		return c.Documents.Create(context.Background(), body, l.callOptions()...)
	},
	"CreateUpload": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		l := decode[labels](t, in)
		return c.Uploads.Reserve(context.Background(), decode[caitlyn.CreateUploadInput](t, in), l.callOptions()...)
	},
	"GetAgentVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		l := decode[labels](t, in)
		return c.Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: l.AgentID, Version: l.Version})
	},
	"ListDocuments": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		l := decode[labels](t, in)
		pages := c.Documents.ListPages(context.Background(), &caitlyn.ListDocumentsInput{KnowledgeBaseID: l.KnowledgeBaseID, Limit: l.Limit,
			Cursor: l.Cursor, Sort: l.Sort, Folder: l.Folder, Status: l.Status, NamePrefix: l.NamePrefix})
		for page, err := range pages { // the example is one page
			return page, err
		}
		return nil, nil
	},
	"ResumeConversationStream": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		l := decode[labels](t, in)
		return drain(c.Conversations.Resume(context.Background(), l.ConversationID, &caitlyn.ResumeConversationStreamInput{LastEventID: l.LastEventID}))
	},
	"SendMessage": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		l := decode[labels](t, in)
		return drain(c.Conversations.Send(context.Background(), l.ConversationID, decode[caitlyn.SendMessageInput](t, in)))
	},
	"UpdateDraftVersion": func(t *testing.T, c *caitlyn.Client, in json.RawMessage) (any, error) {
		l := decode[labels](t, in)
		return c.Versions.UpdateDraft(context.Background(), l.AgentID, decode[caitlyn.UpdateDraftVersionInput](t, in), l.callOptions()...)
	},
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
				assertSubset(t, v, actual.MapIndex(reflect.ValueOf(k)), at+"."+k)
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
	_, err := client(t, m).Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "v99"})
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

// TestGoIfMatchRequiredBeforeSending: an update without WithIfMatch fails before anything is sent.
func TestGoIfMatchRequiredBeforeSending(t *testing.T) {
	m := fresh(t)
	_, err := client(t, m).Versions.UpdateDraft(context.Background(), agent, &caitlyn.UpdateDraftVersionInput{Instructions: caitlyn.Ptr("x")})
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
