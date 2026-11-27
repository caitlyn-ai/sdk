package e2e

// Hands-on feedback on the CLI: each test here failed before its fix.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

// knowledge-bases create --wait follows the knowledge base it created: its id is in the 202's body (and Location),
// never a flag, so the watch must take it from there.
func TestKnowledgeBaseCreateWaitFollowsTheNewKnowledgeBase(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "knowledge-bases", "create", "--name", "Handbook", "--wait", "--timeout", "30s", "-o", "json")
	if r.code != 0 {
		t.Fatalf("exit %d: %s %s", r.code, r.out, r.errOut)
	}
	var kb struct{ ID, Status string }
	if err := json.Unmarshal([]byte(r.out), &kb); err != nil {
		t.Fatalf("prints the knowledge base once ready: %v %s", err, r.out)
	}
	if !strings.HasPrefix(kb.ID, "KB") || kb.Status != "ready" {
		t.Fatalf("the new knowledge base, ready: %+v", kb)
	}
}

// --generate-input prints the skeleton without the required members' values: finding them out is what it is for.
func TestGenerateInputNeedsNoRequiredFlags(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "knowledge-bases", "documents", "update", "--generate-input")
	if r.code != 0 {
		t.Fatalf("exit %d: %s %s", r.code, r.out, r.errOut)
	}
	if !strings.Contains(r.out, "# Input for UpdateDocument") || !strings.Contains(r.out, "\nname: ") {
		t.Fatalf("the skeleton, though the document, its knowledge base and --if-match aren't given:\n%s", r.out)
	}
}

// --name stays optional on agents draft publish (the server is to name an unnamed version itself). Until it does, a
// server that refuses a publish with no name gets a hint naming --name; the CLI never makes a name up.
func TestDraftPublishWithoutNameHintsAtName(t *testing.T) {
	reset(t)
	h := run(t, nil, "", "agents", "draft", "publish", "--help")
	for _, line := range strings.Split(h.out, "\n") {
		if strings.Contains(line, "--name ") && strings.Contains(line, "(required)") {
			t.Fatalf("--name is optional: %s", line)
		}
	}
	r := run(t, nil, "", "agents", "draft", "publish", agentID, "--yes", "-o", "json")
	var body struct {
		Error struct {
			Code string
			Hint struct {
				Missing []string
				Next    []struct{ Run string }
			}
		}
	}
	if err := json.Unmarshal([]byte(r.errOut), &body); err != nil || r.code == 0 {
		t.Fatalf("the server refuses it: %d %v %s", r.code, err, r.errOut)
	}
	if body.Error.Code != "VALIDATION_FAILED" || len(body.Error.Hint.Missing) != 1 || body.Error.Hint.Missing[0] != "--name" {
		t.Fatalf("the hint names --name: %s", r.errOut)
	}
	if len(body.Error.Hint.Next) == 0 || !strings.Contains(body.Error.Hint.Next[0].Run, "agents draft publish "+agentID) || !strings.HasSuffix(body.Error.Hint.Next[0].Run, "--name <name>") {
		t.Fatalf("the next step is the command with --name: %s", r.errOut)
	}
	var calls []map[string]any
	getJSON(t, "/__mock/requests", &calls)
	for _, c := range calls {
		if c["method"] == "POST" && strings.Contains(fmt.Sprint(c["path"]), "/versions/draft/publish") {
			if b := fmt.Sprint(c["body"]); strings.Contains(b, `"name"`) {
				t.Fatalf("the CLI sends no name of its own: %s", b)
			}
		}
	}
}

// A confirmation error lists every confirmation that's missing, so one retry is enough: in CI, deleting a knowledge
// base with neither --yes nor --confirm names both, and the next step gives both.
func TestConfirmationRequiredListsEveryMissingConfirmation(t *testing.T) {
	reset(t)
	ci := map[string]string{"GITLAB_CI": "true", "CI": "true"}
	hint := func(r result) (missing []string, next []string) {
		var body struct {
			Error struct {
				Code string
				Hint struct {
					Missing []string
					Next    []struct{ Run string }
				}
			}
		}
		if err := json.Unmarshal([]byte(r.errOut), &body); err != nil || r.code != 3 || body.Error.Code != "CONFIRMATION_REQUIRED" {
			t.Fatalf("exit 3, CONFIRMATION_REQUIRED: %d %v %s", r.code, err, r.errOut)
		}
		for _, n := range body.Error.Hint.Next {
			next = append(next, n.Run)
		}
		return body.Error.Hint.Missing, next
	}
	missing, next := hint(run(t, ci, "", "knowledge-bases", "delete", kbID, "-o", "json"))
	if strings.Join(missing, ",") != "--yes,--confirm" {
		t.Fatalf("both are missing: %v", missing)
	}
	last := next[len(next)-1]
	if !strings.Contains(last, "--yes") || !strings.Contains(last, "--confirm "+kbID) {
		t.Fatalf("the next step gives both: %v", next)
	}
	// Only --yes given: only --confirm is missing, and --yes isn't given twice
	missing, next = hint(run(t, ci, "", "knowledge-bases", "delete", kbID, "--yes", "-o", "json"))
	if strings.Join(missing, ",") != "--confirm" || strings.Count(next[len(next)-1], "--yes") != 1 {
		t.Fatalf("only --confirm: %v %v", missing, next)
	}
	// The wrong target given, no --yes: both again, the wrong --confirm replaced
	missing, next = hint(run(t, ci, "", "knowledge-bases", "delete", kbID, "--confirm", "KBOTHER", "-o", "json"))
	if strings.Join(missing, ",") != "--yes,--confirm" || strings.Contains(next[len(next)-1], "KBOTHER") {
		t.Fatalf("a wrong target: %v %v", missing, next)
	}
	// Both given: it runs
	if r := run(t, ci, "", "knowledge-bases", "delete", kbID, "--yes", "--confirm", kbID); r.code != 0 {
		t.Fatalf("with both: %d %s", r.code, r.errOut)
	}
}

// documents download saves the bytes: to the document's own name by default, to --out, or to stdout with --out -,
// never binary to a terminal; -o is the output format, and a file name there says to use --out.
func TestDocumentDownloadSavesTheBytes(t *testing.T) {
	reset(t)
	in := func(args ...string) result { return runIO(t, nil, "", nil, args...) }
	// The document's own name, in the current folder (the run's home)
	r := in("kb", "documents", "download", "doc-0001", "--kb", kbID, "-o", "table")
	if r.code != 0 || !strings.Contains(r.errOut, "policy-1.pdf") {
		t.Fatalf("saves policy-1.pdf: %d %s %s", r.code, r.out, r.errOut)
	}
	// --out <file>
	file := filepath.Join(t.TempDir(), "copy.pdf")
	r = in("kb", "documents", "download", "doc-0001", "--kb", kbID, "--out", file)
	if r.code != 0 {
		t.Fatalf("--out: %d %s", r.code, r.errOut)
	}
	b, _ := os.ReadFile(file)
	if !strings.HasPrefix(string(b), "mock bytes of doc-0001") {
		t.Fatalf("the document's bytes: %q", b)
	}
	// An existing file is kept, unless --force
	if r = in("kb", "documents", "download", "doc-0001", "--kb", kbID, "-O", file); r.code != 2 || !strings.Contains(r.errOut, "--force") {
		t.Fatalf("an existing file is refused: %d %s", r.code, r.errOut)
	}
	if r = in("kb", "documents", "download", "doc-0001", "--kb", kbID, "-O", file, "--force"); r.code != 0 {
		t.Fatalf("--force replaces it: %d %s", r.code, r.errOut)
	}
	// --out - to a pipe: the bytes on stdout
	if r = in("kb", "documents", "download", "doc-0001", "--kb", kbID, "--out", "-"); r.code != 0 || !strings.HasPrefix(r.out, "mock bytes of doc-0001") {
		t.Fatalf("--out - writes the bytes: %d %q %s", r.code, r.out, r.errOut)
	}
	// --out - to a terminal: a PDF is refused
	r = runIO(t, nil, "", func(s *iostreams.IOStreams) { s.SetTTY(false, true, true) }, "kb", "documents", "download", "doc-0001", "--kb", kbID, "--out", "-")
	if r.code != 2 || r.out != "" || !strings.Contains(r.errOut, "terminal") {
		t.Fatalf("no binary on a terminal: %d %q %s", r.code, r.out, r.errOut)
	}
	// -o with a file name says what to use
	if r = in("kb", "documents", "download", "doc-0001", "--kb", kbID, "-o", "copy.pdf"); r.code != 2 || !strings.Contains(r.errOut, "--out copy.pdf") {
		t.Fatalf("-o file: %d %s", r.code, r.errOut)
	}
	// --url-only, and -o json without --out: the address, as before
	if r = in("kb", "documents", "download", "doc-0001", "--kb", kbID, "-o", "json"); r.code != 0 || !strings.Contains(r.out, `"url"`) {
		t.Fatalf("-o json prints the address: %d %s %s", r.code, r.out, r.errOut)
	}
	if r = in("kb", "documents", "download", "doc-0001", "--kb", kbID, "--url-only"); r.code != 0 || !strings.Contains(r.out, "expiresAt") && !strings.Contains(r.out, "http") {
		t.Fatalf("--url-only prints the address: %d %s %s", r.code, r.out, r.errOut)
	}
}

// A download that fails part way leaves no file behind.
func TestDocumentDownloadFailureLeavesNothing(t *testing.T) {
	reset(t)
	faults(t, map[string]any{"status": map[string]any{"GetObject": []map[string]any{{"status": 500}}}})
	dir := t.TempDir()
	file := filepath.Join(dir, "copy.pdf")
	r := run(t, nil, "", "kb", "documents", "download", "doc-0001", "--kb", kbID, "--out", file)
	if r.code == 0 {
		t.Fatalf("a failed fetch fails: %s", r.errOut)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("nothing is left behind: %v", entries)
	}
}

// kb sync --estimate prints the plan however pricing goes: with the price, or saying it is unavailable, exit 0 either
// way, and uploads nothing.
func TestSyncEstimatePlansWhenPricingIsUnavailable(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "leave-policy.pdf"), []byte("%PDF-1.4 leave"), 0o644)
	os.WriteFile(filepath.Join(dir, "pay.pdf"), []byte("%PDF-1.4 pay"), 0o644)

	reset(t)
	r := run(t, nil, "", "kb", "sync", kbID, dir, "--folder", "/handbook/", "--estimate", "--timeout", "60s", "-o", "table")
	if r.code != 0 || !strings.Contains(r.errOut, "Planned: 2 new") || !strings.Contains(r.errOut, "Estimate:") {
		t.Fatalf("a priced plan: %d %s", r.code, r.errOut)
	}

	reset(t)
	faults(t, map[string]any{"status": map[string]any{"EstimateIngestion": []map[string]any{{"status": 503}, {"status": 503}, {"status": 503}, {"status": 503}}}})
	r = run(t, nil, "", "kb", "sync", kbID, dir, "--folder", "/handbook/", "--estimate", "--timeout", "60s", "-o", "table")
	if r.code != 0 {
		t.Fatalf("pricing unavailable still plans, exit 0: %d %s", r.code, r.errOut)
	}
	for _, want := range []string{"Planned: 2 new", "To upload: ", "Price unavailable"} {
		if !strings.Contains(r.errOut, want) {
			t.Fatalf("says %q:\n%s", want, r.errOut)
		}
	}
	reset(t)
	faults(t, map[string]any{"status": map[string]any{"EstimateIngestion": []map[string]any{{"status": 503}, {"status": 503}, {"status": 503}, {"status": 503}}}})
	r = run(t, nil, "", "kb", "sync", kbID, dir, "--folder", "/handbook/", "--estimate", "--timeout", "60s", "-o", "json")
	var plan struct {
		Bytes         int64
		Items         []map[string]any
		EstimateError *struct{ Code string } `json:"estimateError"`
	}
	if err := json.Unmarshal([]byte(r.out), &plan); r.code != 0 || err != nil {
		t.Fatalf("JSON: %d %v %s %s", r.code, err, r.out, r.errOut)
	}
	if len(plan.Items) != 2 || plan.Bytes == 0 || plan.EstimateError == nil || plan.EstimateError.Code != "SERVICE_UNAVAILABLE" {
		t.Fatalf("the plan, its bytes and why it has no price: %s", r.out)
	}
	var reqs []map[string]any
	getJSON(t, "/__mock/requests", &reqs)
	for _, q := range reqs {
		if p, _ := q["path"].(string); strings.HasPrefix(p, "/__s3") || strings.HasSuffix(p, "/start") {
			t.Fatalf("nothing is uploaded or started: %v", q)
		}
	}
}

// chat and the watch commands are conversations, not data: on a terminal, outside CI and an agent's session, they
// render for people whatever output the configuration or environment sets. Only -o (or --query/--jq) on the command
// line asks for the events as data; anywhere else, the configured format holds as before.
func TestStreamsRenderForPeopleOnATerminal(t *testing.T) {
	terminal := func(s *iostreams.IOStreams) { s.SetTTY(true, true, true) }
	jsonDefault := map[string]string{"CAITLYN_OUTPUT": "json"}
	with := func(extra map[string]string) map[string]string {
		env := map[string]string{"CAITLYN_OUTPUT": "json"}
		for k, v := range extra {
			env[k] = v
		}
		return env
	}
	events := func(out string) bool { return strings.HasPrefix(strings.TrimSpace(out), "{") }
	ask := []string{"chat", agentID + "@draft", "--", "How much annual leave?"}

	reset(t)
	// A terminal, JSON configured: the answer, rendered
	r := runIO(t, jsonDefault, "", terminal, ask...)
	if r.code != 0 || events(r.out) || !strings.Contains(r.out, "leave-policy.pdf, page 3") {
		t.Fatalf("a terminal renders the answer: %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	// The same from a project file's output
	project := filepath.Join(t.TempDir(), ".caitlyn.toml")
	os.WriteFile(project, []byte("output = \"json\"\n"), 0o644)
	r = runIO(t, nil, "", terminal, "chat", "--project-file", project, agentID+"@draft", "--", "How much annual leave?")
	if r.code != 0 || events(r.out) {
		t.Fatalf("a project file's output is a default too: %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	// -o on the command line: the events, as data
	r = runIO(t, jsonDefault, "", terminal, "chat", "-o", "jsonl", agentID+"@draft", "--", "How much annual leave?")
	if r.code != 0 || !events(r.out) {
		t.Fatalf("-o jsonl gives the events: %d\n%s", r.code, r.out)
	}
	// Not a terminal, CI, or an agent's session (one allowed to chat): the configured format, as before
	agentHome := t.TempDir()
	os.MkdirAll(filepath.Join(agentHome, ".caitlyn"), 0o700)
	os.WriteFile(filepath.Join(agentHome, ".caitlyn", "config"), []byte("[profiles.default]\nagent_scopes = \"full\"\n"), 0o600)
	for name, c := range map[string]struct {
		env   map[string]string
		setup func(*iostreams.IOStreams)
	}{
		"piped": {jsonDefault, nil},
		"CI":    {with(map[string]string{"GITLAB_CI": "true", "CI": "true"}), terminal},
		"agent": {with(map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1", "CAITLYN_CONFIG_DIR": filepath.Join(agentHome, ".caitlyn")}), terminal},
	} {
		if r := runIO(t, c.env, "", c.setup, ask...); r.code != 0 || !events(r.out) {
			t.Fatalf("%s keeps the events: %d\n%s\n%s", name, r.code, r.out, r.errOut)
		}
	}
	// With no message on a terminal, JSON configured: the conversation opens (and ends with stdin)
	r = runIO(t, jsonDefault, "/quit\n", terminal, "chat", agentID+"@draft")
	if r.code != 0 || strings.Contains(r.errOut, "Give a message") || !strings.Contains(r.errOut, "Type a message") {
		t.Fatalf("interactive chat opens: %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	// A watch command follows the same rule
	watch := []string{"knowledge-bases", "watch", kbID, "--until-match", "true", "--timeout", "10s"}
	if r := runIO(t, jsonDefault, "", terminal, watch...); events(r.out) {
		t.Fatalf("a watch on a terminal renders: %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	if r := runIO(t, jsonDefault, "", terminal, append(watch, "-o", "jsonl")...); !events(r.out) {
		t.Fatalf("a watch with -o jsonl gives the events: %d\n%s\n%s", r.code, r.out, r.errOut)
	}
}
