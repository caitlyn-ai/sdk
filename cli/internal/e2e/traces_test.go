package e2e

import (
	"bytes"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

// otlpReceiver is a fake OpenTelemetry collector: it keeps every OTLP/HTTP trace export it receives.
type otlpReceiver struct {
	srv     *httptest.Server
	mu      sync.Mutex
	bodies  [][]byte
	headers []http.Header
	paths   []string
}

func newOTLPReceiver(t *testing.T) *otlpReceiver {
	r := &otlpReceiver{}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		b, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		r.bodies = append(r.bodies, b)
		r.headers = append(r.headers, req.Header.Clone())
		r.paths = append(r.paths, req.URL.Path)
		r.mu.Unlock()
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

type exportedSpan struct {
	name, traceID string
	attrs         map[string]string
	resource      map[string]string
}

func (r *otlpReceiver) spans(t *testing.T) []exportedSpan {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []exportedSpan
	for _, b := range r.bodies {
		var req coltrace.ExportTraceServiceRequest
		if err := proto.Unmarshal(b, &req); err != nil {
			t.Fatalf("not an OTLP trace export: %v", err)
		}
		for _, rs := range req.ResourceSpans {
			res := map[string]string{}
			for _, a := range rs.Resource.GetAttributes() {
				res[a.Key] = a.Value.GetStringValue()
			}
			for _, ss := range rs.ScopeSpans {
				for _, s := range ss.Spans {
					attrs := map[string]string{}
					for _, a := range s.Attributes {
						attrs[a.Key] = a.Value.String()
					}
					out = append(out, exportedSpan{name: s.Name, traceID: hex.EncodeToString(s.TraceId), attrs: attrs, resource: res})
				}
			}
		}
	}
	return out
}

// Your own traces (round 10): with OTEL_EXPORTER_OTLP_ENDPOINT set, a command exports a root span named after it
// and the SDK's span per API call, over OTLP/HTTP to /v1/traces, with the standard OTEL_* variables honoured, W3C
// traceparent sent to the API in the same trace, and never a token, the Authorization header or a body in the
// export. It turns usage data for Caitlyn on no more than usage data turns it on.
func TestYourOwnTracesExportToYourCollector(t *testing.T) {
	reset(t)
	rcv := newOTLPReceiver(t)
	env := map[string]string{
		"OTEL_EXPORTER_OTLP_ENDPOINT": rcv.srv.URL,
		"OTEL_EXPORTER_OTLP_HEADERS":  "x-collector-key=abc%20123",
		"OTEL_RESOURCE_ATTRIBUTES":    "deployment.environment=test",
	}
	if r := run(t, env, "", "agents", "get", agentID); r.code != 0 {
		t.Fatalf("agents get: %d %s", r.code, r.errOut)
	}
	if len(rcv.paths) == 0 || rcv.paths[0] != "/v1/traces" || rcv.headers[0].Get("x-collector-key") != "abc 123" {
		t.Fatalf("export: paths %v, headers %v", rcv.paths, rcv.headers)
	}
	spans := rcv.spans(t)
	var root, call *exportedSpan
	for i := range spans {
		switch spans[i].name {
		case "caitlyn agents get":
			root = &spans[i]
		case "caitlyn.call":
			call = &spans[i]
		}
	}
	if root == nil || call == nil {
		t.Fatalf("want the command's root span and an API call span, got %+v", spans)
	}
	if root.traceID != call.traceID {
		t.Errorf("the call span isn't in the command's trace: %s, %s", root.traceID, call.traceID)
	}
	if root.resource["service.name"] != "caitlyn-cli" || root.resource["deployment.environment"] != "test" {
		t.Errorf("resource: %v", root.resource)
	}
	for _, b := range rcv.bodies {
		for _, secret := range []string{"pat_test", "Bearer", "authorization", "Authorization"} {
			if bytes.Contains(b, []byte(secret)) {
				t.Errorf("the export holds %q", secret)
			}
		}
	}
	// traceparent went to the API, in the command's trace
	var reqs []map[string]any
	getJSON(t, "/__mock/requests", &reqs)
	found := false
	for _, q := range reqs {
		h, _ := q["headers"].(map[string]any)
		if tp, _ := h["traceparent"].(string); tp != "" {
			found = true
			if !strings.Contains(tp, root.traceID) {
				t.Errorf("traceparent %s isn't the command's trace %s", tp, root.traceID)
			}
		}
	}
	if !found {
		t.Error("no traceparent reached the API")
	}
	// Independent of usage data for Caitlyn: still off
	if r := run(t, env, "", "telemetry", "status", "-o", "json"); !strings.Contains(r.out, `"on":false`) {
		t.Errorf("your own traces turned usage data for Caitlyn on: %s", r.out)
	}
}

// OTEL_SERVICE_NAME names the service, over a service.name in OTEL_RESOURCE_ATTRIBUTES (the specification's order);
// OTEL_SDK_DISABLED=true exports nothing; with no endpoint nothing is exported,
// even with usage data for Caitlyn turned on.
func TestYourOwnTracesSwitches(t *testing.T) {
	reset(t)
	rcv := newOTLPReceiver(t)
	run(t, map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": rcv.srv.URL, "OTEL_SERVICE_NAME": "nightly-sync", "OTEL_RESOURCE_ATTRIBUTES": "service.name=from-attributes"}, "", "agents", "list")
	if s := rcv.spans(t); len(s) == 0 || s[0].resource["service.name"] != "nightly-sync" {
		t.Fatalf("OTEL_SERVICE_NAME: %+v", s)
	}
	before := len(rcv.spans(t))
	run(t, map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": rcv.srv.URL, "OTEL_SDK_DISABLED": "true"}, "", "agents", "list")
	run(t, map[string]string{"CAITLYN_TELEMETRY": "1"}, "", "agents", "list")
	if after := len(rcv.spans(t)); after != before {
		t.Fatalf("exported %d spans with OTEL_SDK_DISABLED or no endpoint", after-before)
	}
}

// A collector that never answers costs a command about a second, never more.
func TestYourOwnTracesDeadCollector(t *testing.T) {
	reset(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close() // accept and never answer
		}
	}()
	start := time.Now()
	r := run(t, map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://" + ln.Addr().String()}, "", "agents", "list")
	if took := time.Since(start); r.code != 0 || took > 2500*time.Millisecond {
		t.Fatalf("exit %d after %s with a dead collector", r.code, took)
	}
}
