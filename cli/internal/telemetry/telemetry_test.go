package telemetry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/config"
)

func TestPayloadHasOnlyTheListedFields(t *testing.T) {
	e := Event{EventID: "e", Time: "t", InstallID: "i", Command: "kb sync", Flags: []string{"--yes"}, ExitCode: 3,
		DurationMS: 10, Version: "0.12.0", Channel: "stable", OS: "linux", Arch: "amd64", CI: true, CIProvider: "gitlab",
		Agent: true, AgentName: "claude-code", TTY: [3]bool{true, false, true}}
	b, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	var got []string
	for k := range m {
		got = append(got, k)
	}
	want := append([]string(nil), Fields...)
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("payload fields %v, the list says %v: a field was added without changing the list (9.1)", got, want)
	}
	// And the struct has no field that could hold more (a map, an any, an error message)
	ty := reflect.TypeOf(e)
	for i := 0; i < ty.NumField(); i++ {
		switch ty.Field(i).Type.Kind() {
		case reflect.String, reflect.Int, reflect.Int64, reflect.Bool, reflect.Array, reflect.Slice:
		default:
			t.Errorf("field %s is a %s", ty.Field(i).Name, ty.Field(i).Type)
		}
	}
}

func TestRounding(t *testing.T) {
	if got := RoundDuration(52314 * time.Millisecond); got != 52310 {
		t.Fatalf("got %d", got)
	}
	if got := RoundDuration(52316 * time.Millisecond); got != 52320 {
		t.Fatalf("got %d", got)
	}
	// the exact time, in UTC, to the millisecond (Sam, November 2026: no rounding and no offset)
	nz := time.FixedZone("NZDT", 13*3600)
	if got := FormatTime(time.Date(2026, 11, 26, 9, 47, 12, 5_400_000, nz)); got != "2026-11-25T20:47:12.005Z" {
		t.Fatalf("got %s", got)
	}
	id := NewUUID()
	if len(id) != 36 || id[14] != '4' || NewUUID() == id {
		t.Fatalf("not a random v4 UUID: %s", id)
	}
}

func env(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

// TestSwitchOrder checks every switch and that the first match wins (9.1).
func TestSwitchOrder(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		user string
		ci   bool
		on   bool
		rule int
	}{
		{"off by default: opt-in", nil, "", false, false, 6},
		{"caitlyn telemetry on", nil, "true", false, true, 5},
		{"CAITLYN_TELEMETRY=0", map[string]string{"CAITLYN_TELEMETRY": "0"}, "", false, false, 1},
		{"CAITLYN_TELEMETRY=off", map[string]string{"CAITLYN_TELEMETRY": "off"}, "", false, false, 1},
		{"CAITLYN_TELEMETRY=1 beats DO_NOT_TRACK", map[string]string{"CAITLYN_TELEMETRY": "1", "DO_NOT_TRACK": "1"}, "", false, true, 1},
		{"CAITLYN_TELEMETRY=1 beats the user file", map[string]string{"CAITLYN_TELEMETRY": "1"}, "false", false, true, 1},
		{"CAITLYN_TELEMETRY=1 beats CI", map[string]string{"CAITLYN_TELEMETRY": "on"}, "", true, true, 1},
		{"CAITLYN_TELEMETRY=0 beats everything", map[string]string{"CAITLYN_TELEMETRY": "0"}, "true", false, false, 1},
		{"an unknown CAITLYN_TELEMETRY falls through", map[string]string{"CAITLYN_TELEMETRY": "maybe"}, "", false, false, 6},
		{"DO_NOT_TRACK=1", map[string]string{"DO_NOT_TRACK": "1"}, "", false, false, 2},
		{"DO_NOT_TRACK=true beats the user file", map[string]string{"DO_NOT_TRACK": "true"}, "true", false, false, 2},
		{"DO_NOT_TRACK=0 is not set", map[string]string{"DO_NOT_TRACK": "0"}, "true", false, true, 5},
		{"the user file", nil, "false", false, false, 3},
		{"the user file beats CI", nil, "false", true, false, 3},
		{"user true doesn't beat CI", nil, "true", true, false, 4},
		{"CI", nil, "", true, false, 4},
	}
	for _, c := range cases {
		d := Decide(Inputs{Lookup: env(c.env), UserSetting: c.user, CI: c.ci, Endpoint: "https://t.example"})
		if d.On != c.on || d.Rule != c.rule {
			t.Errorf("%s: on=%v rule=%d, want on=%v rule=%d (%s)", c.name, d.On, d.Rule, c.on, c.rule, d.Reason)
		}
	}
	d := Decide(Inputs{Lookup: env(nil), UserSetting: "true"})
	if !d.On || !d.NoEndpoint || d.Collects() {
		t.Fatal("with no endpoint, nothing is collected")
	}
}

func ev(at time.Time, i int) Event {
	return Event{EventID: fmt.Sprintf("e%04d", i), Time: FormatTime(at), InstallID: "i", Command: "agents list", Flags: []string{}, Version: "0.12.0"}
}

func TestQueueModeAndFlushTriggers(t *testing.T) {
	now := time.Date(2026, 11, 25, 14, 0, 0, 0, time.UTC)
	q := Queue{Dir: filepath.Join(t.TempDir(), "telemetry"), Now: func() time.Time { return now }}
	for i := 0; i < FlushCount-1; i++ {
		due, err := q.Append(ev(now, i))
		if err != nil || due {
			t.Fatalf("event %d: due=%v err=%v", i, due, err)
		}
	}
	st, _ := os.Stat(q.Path())
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("queue mode %o, want 600", st.Mode().Perm())
	}
	if due, _ := q.Append(ev(now, 99)); !due {
		t.Fatal("20 events start a flush")
	}
	q2 := Queue{Dir: filepath.Join(t.TempDir(), "telemetry"), Now: func() time.Time { return now }}
	_, _ = q2.Append(ev(now.Add(-25*time.Hour), 1))
	if due, _ := q2.Append(ev(now, 2)); !due {
		t.Fatal("an event a day old starts a flush")
	}
}

func TestQueueCaps(t *testing.T) {
	now := time.Date(2026, 11, 25, 14, 0, 0, 0, time.UTC)
	q := Queue{Dir: t.TempDir(), Now: func() time.Time { return now }}
	// Older than a week: dropped
	_, _ = q.Append(ev(now.Add(-8*24*time.Hour), 0))
	_, _ = q.Append(ev(now, 1))
	evs, _ := q.Pending()
	if len(evs) != 1 || evs[0].EventID != "e0001" {
		t.Fatalf("events older than 7 days are dropped: %+v", evs)
	}
	// Past 256 KB: the oldest go
	big := ev(now, 0)
	big.Flags = []string{strings.Repeat("x", 2000)}
	for i := 0; i < 200; i++ {
		e := big
		e.EventID = fmt.Sprintf("b%04d", i)
		if _, err := q.Append(e); err != nil {
			t.Fatal(err)
		}
	}
	st, _ := os.Stat(q.Path())
	if st.Size() > MaxQueueBytes {
		t.Fatalf("queue is %d bytes, over %d", st.Size(), MaxQueueBytes)
	}
	evs, _ = q.Pending()
	if evs[len(evs)-1].EventID != "b0199" || evs[0].EventID == "b0000" {
		t.Fatal("the newest events are kept, the oldest dropped")
	}
}

func TestFlush(t *testing.T) {
	var got Batch
	var status atomic.Int32
	status.Store(500)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		if r.Header.Get("Content-Type") != "application/json" || r.Method != http.MethodPost {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(int(status.Load()))
	}))
	defer srv.Close()
	now := time.Now()
	q := Queue{Dir: t.TempDir(), Now: func() time.Time { return now }}
	for i := 0; i < 3; i++ {
		_, _ = q.Append(ev(now, i))
	}
	if _, err := q.Flush(context.Background(), srv.URL, nil); err == nil {
		t.Fatal("a 500 is a failure")
	}
	if evs, _ := q.Pending(); len(evs) != 3 {
		t.Fatalf("a failed flush keeps the queue: %d", len(evs))
	}
	status.Store(202)
	n, err := q.Flush(context.Background(), srv.URL, nil)
	if err != nil || n != 3 || len(got.Events) != 3 || got.Schema != SchemaID {
		t.Fatalf("n=%d err=%v sent=%d schema=%q", n, err, len(got.Events), got.Schema)
	}
	if evs, _ := q.Pending(); len(evs) != 0 {
		t.Fatal("accepted events are deleted")
	}
	if m, _ := filepath.Glob(filepath.Join(q.Dir, "queue.*.sending")); len(m) != 0 {
		t.Fatal("no batch file is left")
	}
}

func TestFlushGivesUpAfter3Seconds(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	q := Queue{Dir: t.TempDir()}
	_, _ = q.Append(ev(time.Now(), 1))
	start := time.Now()
	_, err := q.Flush(context.Background(), srv.URL, nil)
	took := time.Since(start)
	if err == nil || took < PostTimeout-100*time.Millisecond || took > PostTimeout+time.Second {
		t.Fatalf("took %s, err %v", took, err)
	}
	if evs, _ := q.Pending(); len(evs) != 1 {
		t.Fatal("a timed-out flush keeps the queue")
	}
}

func TestDeleteAndReset(t *testing.T) {
	q := Queue{Dir: t.TempDir()}
	id1, _ := q.InstallID()
	_, _ = q.Append(ev(time.Now(), 1))
	id2, err := q.Reset()
	if err != nil || id2 == id1 || id2 == "" {
		t.Fatalf("reset: %s → %s, %v", id1, id2, err)
	}
	if evs, _ := q.Pending(); len(evs) != 0 {
		t.Fatal("reset deletes the queue")
	}
	if again, _ := q.InstallID(); again != id2 {
		t.Fatal("the install ID is kept between runs")
	}
}

func TestClaimSpawnOncePerMinute(t *testing.T) {
	now := time.Now()
	q := Queue{Dir: t.TempDir(), Now: func() time.Time { return now }}
	if !q.ClaimSpawn() || q.ClaimSpawn() {
		t.Fatal("one flush a minute")
	}
	now = now.Add(2 * time.Minute)
	if !q.ClaimSpawn() {
		t.Fatal("a minute later, another may start")
	}
}

// The configuration's default for telemetry is the same as the decision's: off (round 6, M2). `config get telemetry`
// and `telemetry status` must never disagree on a fresh home.
func TestConfigDefaultAgreesWithTheDecision(t *testing.T) {
	k := config.KeyNamed("telemetry")
	if k == nil || k.Default != "false" {
		t.Fatalf("the telemetry setting's default is %+v, want false", k)
	}
	if d := Decide(Inputs{Lookup: env(nil), Endpoint: "https://t.example"}); d.On {
		t.Fatalf("the decision with nothing set is on: %+v", d)
	}
}

// The usage-data schema an intake validates with (usage-event.schema.json) is the Event the CLI sends, field for
// field: its properties are Fields, the always-present ones are required, and the docs' example event is a valid
// event with exactly those names (round 10).
func TestUsageSchemaMatchesTheEvent(t *testing.T) {
	b, err := os.ReadFile("usage-event.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Required   []string `json:"required"`
		Properties struct {
			Schema struct {
				Const string `json:"const"`
			} `json:"schema"`
			Events struct {
				MaxItems int `json:"maxItems"`
			} `json:"events"`
		} `json:"properties"`
		Defs struct {
			Event struct {
				AdditionalProperties bool                      `json:"additionalProperties"`
				Required             []string                  `json:"required"`
				Properties           map[string]map[string]any `json:"properties"`
			} `json:"event"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(b, &schema); err != nil {
		t.Fatal(err)
	}
	if schema.Properties.Schema.Const != SchemaID || !contains(schema.Required, "schema") {
		t.Errorf("the schema requires schema %q; the CLI sends %q", schema.Properties.Schema.Const, SchemaID)
	}
	if schema.Properties.Events.MaxItems != MaxBatchEvents {
		t.Errorf("the schema's maxItems %d, the CLI's cap %d", schema.Properties.Events.MaxItems, MaxBatchEvents)
	}
	if !strings.Contains(text0(t), SchemaID) {
		t.Errorf("the docs don't show the payload's schema %s", SchemaID)
	}
	ev := schema.Defs.Event
	var props []string
	for k := range ev.Properties {
		props = append(props, k)
	}
	want := append([]string(nil), Fields...)
	sort.Strings(props)
	sort.Strings(want)
	if !reflect.DeepEqual(props, want) || ev.AdditionalProperties {
		t.Fatalf("schema properties %v (additional %v), Fields %v", props, ev.AdditionalProperties, want)
	}
	optional := map[string]bool{"ci_provider": true, "agent_name": true}
	for _, f := range Fields {
		if !optional[f] != contains(ev.Required, f) {
			t.Errorf("%s: required in the schema %v, but the CLI sends it %s", f, contains(ev.Required, f), map[bool]string{true: "only sometimes", false: "always"}[optional[f]])
		}
	}
	// a real event validates: each string property with a pattern matches it
	e := Event{EventID: NewUUID(), Time: FormatTime(time.Now()), InstallID: NewUUID(), Command: "agents draft save",
		Flags: []string{"--name", "unknown"}, ExitCode: 7, DurationMS: RoundDuration(1234 * time.Millisecond), Version: "0.12.0",
		Channel: "stable", OS: "darwin", Arch: "arm64", CI: true, CIProvider: "gitlab", Agent: true, AgentName: "claude-code", TTY: [3]bool{true, false, true}}
	checkAgainst(t, ev.Properties, e)
	// the docs' example: exactly the always-present fields, and valid
	page, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "cli", "telemetry.md"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(page)
	i := strings.Index(text, "An example event")
	j := strings.Index(text[i:], "```json\n")
	k := strings.Index(text[i+j+8:], "```")
	var doc Event
	raw := text[i+j+8 : i+j+8+k]
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the docs' example isn't an Event: %v\n%s", err, raw)
	}
	var m map[string]any
	_ = json.Unmarshal([]byte(raw), &m)
	for _, f := range ev.Required {
		if _, ok := m[f]; !ok {
			t.Errorf("the docs' example has no %s", f)
		}
	}
	checkAgainst(t, ev.Properties, doc)
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func checkAgainst(t *testing.T, props map[string]map[string]any, e Event) {
	t.Helper()
	b, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for k, v := range m {
		p := props[k]
		if pat, ok := p["pattern"].(string); ok {
			if s, ok := v.(string); !ok || !regexp.MustCompile(pat).MatchString(s) {
				t.Errorf("%s = %v doesn't match %s", k, v, pat)
			}
		}
		if items, ok := p["items"].(map[string]any); ok {
			if pat, ok := items["pattern"].(string); ok {
				for _, it := range v.([]any) {
					if !regexp.MustCompile(pat).MatchString(it.(string)) {
						t.Errorf("%s item %v doesn't match %s", k, it, pat)
					}
				}
			}
		}
		if enum, ok := p["enum"].([]any); ok && !contains(func() []string {
			var out []string
			for _, x := range enum {
				out = append(out, fmt.Sprint(x))
			}
			return out
		}(), fmt.Sprint(v)) {
			t.Errorf("%s = %v isn't one of %v", k, v, enum)
		}
	}
}

func text0(t *testing.T) string {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "cli", "telemetry.md"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The intake's front door (round 11): each request carries the batch's schema, the body's SHA-256 in
// x-amz-content-sha256 (CloudFront signs it to the function URL with origin access control) and a User-Agent, and
// holds at most MaxBatchEvents events and MaxBatchBytes bytes; a bigger queue goes in several requests.
func TestFlushSendsCappedSignedBatches(t *testing.T) {
	var mu sync.Mutex
	var bodies [][]byte
	var hashes, agents []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, b)
		hashes = append(hashes, r.Header.Get("x-amz-content-sha256"))
		agents = append(agents, r.Header.Get("User-Agent"))
		mu.Unlock()
		w.WriteHeader(202)
	}))
	defer srv.Close()
	now := time.Now()
	q := Queue{Dir: t.TempDir(), Now: func() time.Time { return now }, Version: "0.12.0"}
	for i := 0; i < 250; i++ {
		_, _ = q.Append(ev(now, i))
	}
	n, err := q.Flush(context.Background(), srv.URL, nil)
	if err != nil || n != 250 || len(bodies) != 3 {
		t.Fatalf("n=%d err=%v requests=%d", n, err, len(bodies))
	}
	total := 0
	for i, b := range bodies {
		var got Batch
		if err := json.Unmarshal(b, &got); err != nil || got.Schema != SchemaID {
			t.Fatalf("request %d: schema %q, %v", i, got.Schema, err)
		}
		if len(got.Events) > MaxBatchEvents || len(b) > MaxBatchBytes {
			t.Errorf("request %d: %d events, %d bytes", i, len(got.Events), len(b))
		}
		total += len(got.Events)
		sum := sha256.Sum256(b)
		if hashes[i] != hex.EncodeToString(sum[:]) {
			t.Errorf("request %d: x-amz-content-sha256 %q isn't the body's SHA-256", i, hashes[i])
		}
		if agents[i] != "caitlyn-cli/0.12.0" {
			t.Errorf("request %d: User-Agent %q", i, agents[i])
		}
	}
	if total != 250 {
		t.Errorf("%d events sent, want 250", total)
	}
	// big events: the byte cap splits before the count cap does
	evs := make([]Event, 100)
	for i := range evs {
		evs[i] = ev(now, i)
		evs[i].Flags = make([]string, 64)
		for j := range evs[i].Flags {
			evs[i].Flags[j] = "--" + strings.Repeat("x", 20)
		}
	}
	for _, b := range batches(evs) {
		body, _ := json.Marshal(Batch{Schema: SchemaID, Events: b})
		if len(body) > MaxBatchBytes {
			t.Errorf("a batch of %d big events is %d bytes", len(b), len(body))
		}
	}
	if got := len(batches(evs)); got < 2 {
		t.Errorf("100 big events went in %d request(s)", got)
	}
}

// Each answer decides its batch: 2xx sent; 400, 413 and 415 dropped; 429, 503, other 5xx and a network error kept
// for the next flush; 410 deletes the queue and stops this CLI version sending (round 11).
func TestFlushHandlesEachAnswer(t *testing.T) {
	for _, c := range []struct {
		status int
		kept   int
	}{{202, 0}, {400, 0}, {413, 0}, {415, 0}, {429, 3}, {503, 3}, {500, 3}, {502, 3}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(c.status) }))
		now := time.Now()
		q := Queue{Dir: t.TempDir(), Now: func() time.Time { return now }, Version: "0.12.0"}
		for i := 0; i < 3; i++ {
			_, _ = q.Append(ev(now, i))
		}
		_, _ = q.Flush(context.Background(), srv.URL, nil)
		srv.Close()
		if evs, _ := q.Pending(); len(evs) != c.kept {
			t.Errorf("%d: %d events left, want %d", c.status, len(evs), c.kept)
		}
	}
	// a network error keeps the batch
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()
	now := time.Now()
	q := Queue{Dir: t.TempDir(), Now: func() time.Time { return now }, Version: "0.12.0"}
	_, _ = q.Append(ev(now, 1))
	if _, err := q.Flush(context.Background(), url, nil); err == nil {
		t.Error("a network error is a failure")
	}
	if evs, _ := q.Pending(); len(evs) != 1 {
		t.Errorf("a network error kept %d events, want 1", len(evs))
	}
	// a later batch is kept with the one refused for now: the first 100 sent, then 503
	var calls atomic.Int32
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(202)
			return
		}
		w.WriteHeader(503)
	}))
	defer srv.Close()
	q = Queue{Dir: t.TempDir(), Now: func() time.Time { return now }, Version: "0.12.0"}
	for i := 0; i < 250; i++ {
		_, _ = q.Append(ev(now, i))
	}
	n, _ := q.Flush(context.Background(), srv.URL, nil)
	if evs, _ := q.Pending(); n != 100 || len(evs) != 150 || calls.Load() != 2 {
		t.Errorf("sent %d, kept %d, requests %d: want 100, 150 and 2", n, len(evs), calls.Load())
	}
}

// 410 Gone: this version's events are deleted, and it neither queues nor sends to that endpoint again. Another
// endpoint, another version, and another version's queued events aren't touched.
func TestFlushStopsAfterGone(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(410)
	}))
	defer srv.Close()
	now := time.Now()
	dir := t.TempDir()
	q := Queue{Dir: dir, Now: func() time.Time { return now }, Version: "0.12.0"}
	for i := 0; i < 3; i++ {
		_, _ = q.Append(ev(now, i)) // version 0.12.0
	}
	other := ev(now, 7)
	other.Version = "0.13.0"
	_, _ = q.Append(other)
	if _, err := q.Flush(context.Background(), srv.URL, nil); err == nil {
		t.Fatal("410 is reported")
	}
	evs, _ := q.Pending()
	if len(evs) != 1 || evs[0].Version != "0.13.0" || !q.Gone(srv.URL) {
		t.Fatalf("after 410: %v left, gone %v; want only 0.13.0's event, and gone", evs, q.Gone(srv.URL))
	}
	// this version sends nothing more to that endpoint, and deletes nothing either
	if _, err := q.Flush(context.Background(), srv.URL, nil); err == nil || calls.Load() != 1 {
		t.Errorf("this version sent again after 410: %d requests", calls.Load())
	}
	if evs, _ := q.Pending(); len(evs) != 1 {
		t.Errorf("a stopped version deleted another version's events: %d left", len(evs))
	}
	// another endpoint (a test listener's 410 never stops the real one), and another version, aren't stopped
	if q.Gone("https://telemetry.caitlyn.ai/cli") {
		t.Error("a 410 from one endpoint stopped another")
	}
	if next := (Queue{Dir: dir, Now: q.Now, Version: "0.13.0"}); next.Gone(srv.URL) {
		t.Error("a later version starts again")
	}
	// caitlyn telemetry on clears it
	if err := q.ClearStop(); err != nil || q.Gone(srv.URL) {
		t.Errorf("ClearStop: %v, gone %v", err, q.Gone(srv.URL))
	}
}

// Two flushes at once send each event once: the second leaves the batch the first has taken (its file's time is
// when the first took it, not the queue's last Append, which may be minutes old).
func TestConcurrentFlushesSendEachEventOnce(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]int{}
	release := make(chan struct{})
	var first atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b Batch
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		for _, e := range b.Events {
			seen[e.EventID]++
		}
		mu.Unlock()
		if first.CompareAndSwap(false, true) {
			<-release // hold the first flush's request while the second runs
		}
		w.WriteHeader(202)
	}))
	defer srv.Close()
	dir := t.TempDir()
	q := Queue{Dir: dir, Version: "0.12.0"}
	for i := 0; i < 5; i++ {
		_, _ = q.Append(ev(time.Now(), i))
	}
	old := time.Now().Add(-5 * time.Minute) // the last Append was five minutes ago
	_ = os.Chtimes(q.Path(), old, old)
	done := make(chan struct{})
	go func() { _, _ = q.Flush(context.Background(), srv.URL, nil); close(done) }()
	for !first.Load() {
		time.Sleep(5 * time.Millisecond)
	}
	_, _ = q.Flush(context.Background(), srv.URL, nil) // the second, while the first is in flight
	close(release)
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 5 {
		t.Fatalf("%d distinct events sent, want 5", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("%s sent %d times", id, n)
		}
	}
}

// A 429 or 503 with Retry-After keeps the endpoint from being sent to until it passes, at most an hour; the wait is
// per endpoint, and caitlyn telemetry on clears it.
func TestFlushHonoursRetryAfter(t *testing.T) {
	var calls atomic.Int32
	var answer atomic.Value
	answer.Store("120")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", answer.Load().(string))
		w.WriteHeader(503)
	}))
	defer srv.Close()
	now := time.Now()
	clock := func() time.Time { return now }
	q := Queue{Dir: t.TempDir(), Now: clock, Version: "0.12.0"}
	_, _ = q.Append(ev(now, 1))
	_, _ = q.Flush(context.Background(), srv.URL, nil)
	if until := q.WaitUntil(srv.URL); !until.Equal(now.Add(120 * time.Second)) {
		t.Fatalf("WaitUntil %v, want %v", until, now.Add(120*time.Second))
	}
	if _, err := q.Flush(context.Background(), srv.URL, nil); err == nil || calls.Load() != 1 {
		t.Fatalf("sent during the wait: %d requests", calls.Load())
	}
	if !q.WaitUntil("https://telemetry.caitlyn.ai/cli").IsZero() {
		t.Error("the wait applies to another endpoint")
	}
	if evs, _ := q.Pending(); len(evs) != 1 {
		t.Errorf("the event isn't kept during the wait: %d", len(evs))
	}
	now = now.Add(121 * time.Second)
	answer.Store("86400") // a day: capped at an hour
	_, _ = q.Flush(context.Background(), srv.URL, nil)
	if calls.Load() != 2 {
		t.Fatalf("not sent once the wait passed: %d requests", calls.Load())
	}
	if until := q.WaitUntil(srv.URL); !until.Equal(now.Add(MaxRetryAfter)) {
		t.Errorf("a day's Retry-After waits until %v, want an hour (%v)", until, now.Add(MaxRetryAfter))
	}
	if err := q.ClearStop(); err != nil || !q.WaitUntil(srv.URL).IsZero() {
		t.Error("ClearStop doesn't clear the wait")
	}
	for in, want := range map[string]time.Duration{"": 0, "0": 0, "-5": 0, "soon": 0, "30": 30 * time.Second} {
		if got := retryAfter(in, now); got != want {
			t.Errorf("retryAfter(%q) = %s, want %s", in, got, want)
		}
	}
	if got := retryAfter(now.Add(90*time.Second).UTC().Format(http.TimeFormat), now); got < 89*time.Second || got > 90*time.Second {
		t.Errorf("an HTTP date: %s", got)
	}
}

// Events a flush puts back survive Appends that prune and rewrite the queue at the same time: both hold queue.lock.
func TestPutBackSurvivesConcurrentPrune(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond)
		w.WriteHeader(503)
	}))
	defer srv.Close()
	q := Queue{Dir: t.TempDir(), Version: "0.12.0"}
	for i := 0; i < 50; i++ {
		_, _ = q.Append(ev(time.Now(), i))
	}
	// an event 8 days old, so every Append prunes and rewrites
	stale := ev(time.Now().Add(-8*24*time.Hour), 999)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); _, _ = q.Flush(context.Background(), srv.URL, nil) }()
	for i := 100; i < 140; i++ {
		_, _ = q.Append(stale)
		_, _ = q.Append(ev(time.Now(), i))
	}
	wg.Wait()
	evs, _ := q.Pending()
	ids := map[string]bool{}
	for _, e := range evs {
		ids[e.EventID] = true
	}
	for i := 0; i < 50; i++ {
		if !ids[fmt.Sprintf("e%04d", i)] {
			t.Fatalf("e%04d, put back by the flush, was lost (%d events left)", i, len(evs))
		}
	}
}

// batches encodes each event once and keeps every request within both caps.
func TestBatchesCountBytesExactly(t *testing.T) {
	now := time.Now()
	var evs []Event
	for i := 0; i < 400; i++ {
		e := ev(now, i)
		e.Flags = make([]string, i%40)
		for j := range e.Flags {
			e.Flags[j] = "--" + strings.Repeat("y", 30)
		}
		evs = append(evs, e)
	}
	total := 0
	for _, b := range batches(evs) {
		body, _ := json.Marshal(Batch{Schema: SchemaID, Events: b})
		if len(body) > MaxBatchBytes || len(b) > MaxBatchEvents {
			t.Errorf("a batch of %d events is %d bytes", len(b), len(body))
		}
		total += len(b)
	}
	if total != len(evs) {
		t.Errorf("%d events batched, want %d", total, len(evs))
	}
}

// An event carries a release version or "unknown", and a duration of at most a day: what the schema allows.
func TestEventVersionAndDurationFitTheSchema(t *testing.T) {
	if EventVersion("0.13.0-beta.2") != "0.13.0-beta.2" || EventVersion("dev") != "unknown" || EventVersion("") != "unknown" {
		t.Error("EventVersion")
	}
	if RoundDuration(48*time.Hour) != MaxDurationMS || RoundDuration(1234*time.Millisecond) != 1230 {
		t.Error("RoundDuration")
	}
}

// Release and snapshot builds carry the intake's endpoint: .goreleaser.yaml's ldflags set Endpoint to
// ReleaseEndpoint by default, CAITLYN_TELEMETRY_ENDPOINT overrides it, and CLI_TELEMETRY_OFF=1 builds with none. A
// `go build` with no ldflags has none.
func TestReleaseBuildsCarryTheEndpoint(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", ".goreleaser.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	want := `-X github.com/caitlyn-ai/sdk/cli/internal/telemetry.Endpoint={{ if eq (envOrDefault "CLI_TELEMETRY_OFF" "") "1" }}{{ else }}{{ envOrDefault "CAITLYN_TELEMETRY_ENDPOINT" "` + ReleaseEndpoint + `" }}{{ end }}`
	if !strings.Contains(string(b), want) {
		t.Fatalf(".goreleaser.yaml's ldflags don't set the endpoint to %s by default, with CLI_TELEMETRY_OFF to build without one", ReleaseEndpoint)
	}
	if Endpoint != "" {
		t.Fatalf("a build with no ldflags has the endpoint %q; it must have none", Endpoint)
	}
}
