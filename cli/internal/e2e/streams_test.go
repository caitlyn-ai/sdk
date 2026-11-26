package e2e

import (
	"encoding/json"
	"strings"
	"testing"
)

func faults(t *testing.T, f map[string]any) { post(t, "/__mock/faults", f) }

func eventTypes(t *testing.T, out string) []string {
	t.Helper()
	var types []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var ev struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("not JSON Lines: %q", line)
		}
		types = append(types, ev.Type)
	}
	return types
}

// A dropped answer stream resumes with the watch and Last-Event-ID: nothing is lost or repeated (17.2, Streams).
func TestChatResumesAfterADrop(t *testing.T) {
	reset(t)
	faults(t, map[string]any{"dropAfterEvents": 2})
	r := run(t, nil, "", "chat", agentID+"@draft", "How much annual leave?", "-o", "jsonl")
	if r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	types := eventTypes(t, r.out)
	seen := map[string]int{}
	for _, ty := range types {
		seen[ty]++
	}
	if seen["message.completed"] != 1 || seen["message.started"] > 1 {
		t.Fatalf("one complete answer, nothing repeated: %v", types)
	}
}

// Unknown events are data: printed in JSON Lines (8.3).
func TestUnknownEventsArePrinted(t *testing.T) {
	reset(t)
	faults(t, map[string]any{"unknownEvent": true})
	r := run(t, nil, "", "conversations", "watch", "c-1", "--until-match", `.type == "message.completed"`, "--timeout", "20s", "-o", "jsonl")
	if r.code != 0 && r.code != 6 {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
}

// A stream that fails mid-way ends with its error and exit code, never silently.
func TestStreamFailure(t *testing.T) {
	reset(t)
	faults(t, map[string]any{"failStream": true})
	r := run(t, nil, "", "chat", agentID+"@draft", "Hello", "-o", "jsonl")
	if r.code == 0 {
		t.Fatalf("a failed stream must not exit 0:\n%s\n%s", r.out, r.errOut)
	}
	problem(t, r.errOut)
}

// The server's newer version: an operation the workspace's release doesn't have is refused before it is sent,
// exit 8 (17.2, Version skew).
func TestServerOlderThanTheOperation(t *testing.T) {
	reset(t)
	faults(t, map[string]any{"apiVersion": "5.0.0"})
	// the first command learns the workspace's release and remembers it for the profile
	env := map[string]string{"CAITLYN_CONFIG_DIR": t.TempDir()}
	if r := run(t, env, "", "kb", "list"); r.code != 0 {
		t.Fatalf("first: exit %d: %s", r.code, r.errOut)
	}
	r := run(t, env, "", "kb", "list")
	if r.code != 8 || !strings.Contains(r.errOut, "5.0.0") {
		t.Fatalf("the next command is refused before sending, exit 8: %d %s", r.code, r.errOut)
	}
}
