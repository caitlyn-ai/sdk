package telemetry

import (
	"context"
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
	nz := time.FixedZone("NZDT", 13*3600)
	if got := RoundTime(time.Date(2026, 11, 26, 9, 47, 12, 5, nz)); got != "2026-11-25T20:00:00Z" {
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
	return Event{EventID: fmt.Sprintf("e%04d", i), Time: RoundTime(at), InstallID: "i", Command: "agents list", Flags: []string{}, Version: "0.12.0"}
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
	if err != nil || n != 3 || len(got.Events) != 3 {
		t.Fatalf("n=%d err=%v sent=%d", n, err, len(got.Events))
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
	e := Event{EventID: NewUUID(), Time: RoundTime(time.Now()), InstallID: NewUUID(), Command: "agents draft save",
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
