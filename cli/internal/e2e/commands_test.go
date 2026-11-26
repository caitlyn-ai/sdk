package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const (
	agentID = "GHT7YRWXPL"
	kbID    = "KB4T7YQ2WL"
)

func problem(t *testing.T, stderr string) map[string]any {
	t.Helper()
	var p struct {
		Error map[string]any `json:"error"`
	}
	line := strings.TrimSpace(stderr)
	if i := strings.LastIndex(line, "\n{"); i >= 0 {
		line = line[i+1:]
	}
	if err := json.Unmarshal([]byte(line), &p); err != nil {
		t.Fatalf("stderr is not problem details: %v\n%s", err, stderr)
	}
	return p.Error
}

// JSON is the default when stdout isn't a terminal (4.1), and it's the server's own bytes.
func TestJSONWhenPiped(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "agents", "get", agentID)
	if r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	var a map[string]any
	if err := json.Unmarshal([]byte(r.out), &a); err != nil || a["id"] != agentID {
		t.Fatalf("not the agent as JSON: %v\n%s", err, r.out)
	}
}

func TestListPageAndAll(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "kb", "documents", "list", "--kb", kbID, "--limit", "3")
	var page struct {
		Items      []map[string]any `json:"items"`
		NextCursor string           `json:"nextCursor"`
	}
	if r.code != 0 || json.Unmarshal([]byte(r.out), &page) != nil || len(page.Items) != 3 || page.NextCursor == "" {
		t.Fatalf("first page as the wire shape, got exit %d:\n%s\n%s", r.code, r.out, r.errOut)
	}
	r = run(t, nil, "", "kb", "documents", "list", "--kb", kbID, "--limit", "3", "--all", "-o", "jsonl")
	if lines := strings.Split(strings.TrimSpace(r.out), "\n"); r.code != 0 || len(lines) != 7 {
		t.Fatalf("--all -o jsonl: one line per item across pages, got %d:\n%s", len(lines), r.out)
	}
	r = run(t, nil, "", "kb", "documents", "list", "--kb", kbID, "--all", "--jq", ".items[].id")
	if lines := strings.Split(strings.TrimSpace(r.out), "\n"); r.code != 0 || len(lines) != 7 || strings.Contains(r.out, `"`) {
		t.Fatalf("--jq prints strings raw, got:\n%s", r.out)
	}
	r = run(t, nil, "", "kb", "get", kbID, "--query", "name")
	if strings.TrimSpace(r.out) != "HR policies" {
		t.Fatalf("--query: %q", r.out)
	}
}

func TestDryRunSendsNothing(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "agents", "draft", "update", agentID, "--set", "guidance.instructions=Be brief.", "--dry-run=curl")
	if r.code != 0 || !strings.Contains(r.out, "curl -X PATCH") || !strings.Contains(r.out, `$CAITLYN_TOKEN`) || !strings.Contains(r.out, `"instructions":"Be brief."`) {
		t.Fatalf("exit %d:\n%s", r.code, r.out)
	}
	var reqs []map[string]any
	getJSON(t, "/__mock/requests", &reqs)
	for _, q := range reqs {
		if q["method"] == "PATCH" {
			t.Fatalf("a dry run sent %v", q)
		}
	}
}

func TestErrorsCarryHintsAndExitCodes(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "kb", "documents", "get", "no-such-doc", "--kb", kbID)
	if r.code != 6 {
		t.Fatalf("404 is exit 6, got %d: %s", r.code, r.errOut)
	}
	p := problem(t, r.errOut)
	hint, _ := p["hint"].(map[string]any)
	next, _ := hint["next"].([]any)
	if p["exitCode"] != float64(6) || len(next) == 0 || !strings.Contains(next[0].(map[string]any)["run"].(string), "caitlyn knowledge-bases documents list --kb "+kbID) {
		t.Fatalf("the hint should name the list command with the same knowledge base: %v", p)
	}
	// a usage error: nothing sent, exit 2, the missing flag named
	r = run(t, nil, "", "kb", "documents", "list")
	if r.code != 2 || !strings.Contains(r.errOut, "--knowledge-base") {
		t.Fatalf("missing --kb: exit %d %s", r.code, r.errOut)
	}
	// unknown flag
	r = run(t, nil, "", "kb", "list", "--nope")
	if r.code != 2 {
		t.Fatalf("unknown flag: exit %d", r.code)
	}
}

// Agent mode (18.2, 18.5): JSON even on a terminal, --yes for destructive commands, agent scopes checked locally.
func TestAgentMode(t *testing.T) {
	reset(t)
	agent := map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"}
	// the default agent scopes are read only: a write is refused before it is sent, exit 5
	r := run(t, agent, "", "kb", "documents", "delete", "doc-0001", "--kb", kbID, "--yes")
	if r.code != 5 || !strings.Contains(r.errOut, "AGENT_SCOPE_DENIED") {
		t.Fatalf("a write outside the agent scopes exits 5, got %d: %s", r.code, r.errOut)
	}
	// with the scope allowed, it runs
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".caitlyn"), 0o700)
	os.WriteFile(filepath.Join(home, ".caitlyn", "config"), []byte("[profiles.default]\nagent_scopes = \"full\"\n"), 0o600)
	env := map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1", "CAITLYN_CONFIG_DIR": filepath.Join(home, ".caitlyn")}
	r = run(t, env, "", "kb", "documents", "delete", "doc-0001", "--kb", kbID)
	if r.code != 3 || !strings.Contains(r.errOut, "--dry-run") {
		t.Fatalf("a destructive command without --yes exits 3 under an agent, with a hint to --dry-run first: %d %s", r.code, r.errOut)
	}
	r = run(t, env, "", "kb", "documents", "delete", "doc-0001", "--kb", kbID, "--yes")
	if r.code != 0 {
		t.Fatalf("allowed: exit %d: %s", r.code, r.errOut)
	}
	// the highest-impact commands also need --confirm naming the target
	os.WriteFile(filepath.Join(home, ".caitlyn", "config"), []byte("[profiles.default]\nagent_scopes = \"full\"\n"), 0o600)
	r = run(t, env, "", "agents", "delete", agentID, "--yes")
	if r.code != 3 || !strings.Contains(r.errOut, "--confirm") {
		t.Fatalf("agents delete needs --confirm under an agent: %d %s", r.code, r.errOut)
	}
	r = run(t, env, "", "agents", "delete", agentID, "--yes", "--confirm", "WRONGAGENT")
	if r.code != 3 {
		t.Fatalf("a --confirm naming another target is refused: %d", r.code)
	}
	// none: agents may not use the profile at all
	os.WriteFile(filepath.Join(home, ".caitlyn", "config"), []byte("[profiles.default]\nagent_scopes = \"none\"\n"), 0o600)
	r = run(t, env, "", "kb", "list")
	if r.code != 5 || !strings.Contains(r.errOut, "AGENT_NOT_ALLOWED") {
		t.Fatalf("none refuses agents: %d %s", r.code, r.errOut)
	}
}

func TestReadOnlyProfileRefusesWrites(t *testing.T) {
	reset(t)
	r := run(t, map[string]string{"CAITLYN_READ_ONLY": "1"}, "", "kb", "documents", "delete", "doc-0001", "--kb", kbID, "--yes")
	if r.code != 5 || !strings.Contains(r.errOut, "READ_ONLY_PROFILE") {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	if r := run(t, map[string]string{"CAITLYN_READ_ONLY": "1"}, "", "kb", "get", kbID); r.code != 0 {
		t.Fatalf("reads still work: %d %s", r.code, r.errOut)
	}
}

// A destructive command in a script (no terminal, no agent, no CI) can't ask, so it needs --yes.
func TestDestructiveWithoutTerminalNeedsYes(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "kb", "documents", "delete", "doc-0001", "--kb", kbID)
	if r.code != 3 {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
}

func TestAPI(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "api", "GetKnowledgeBase", "--kb", kbID)
	if r.code != 0 || !strings.Contains(r.out, `"HR policies"`) {
		t.Fatalf("by name: %d %s %s", r.code, r.out, r.errOut)
	}
	r = run(t, nil, "", "api", "GET", "/v3/knowledge-bases/"+kbID+"/documents", "--field", "limit=2", "--paginate", "-o", "jsonl")
	if lines := strings.Split(strings.TrimSpace(r.out), "\n"); r.code != 0 || len(lines) != 7 {
		t.Fatalf("by path with --paginate: %d lines\n%s\n%s", len(lines), r.out, r.errOut)
	}
	r = run(t, nil, "", "api", "NoSuchOperation")
	if r.code != 2 {
		t.Fatalf("unknown operation: %d", r.code)
	}
	r = run(t, nil, "", "api", "GetKnowledgeBase", "--kb", kbID, "--include")
	if !strings.Contains(r.out, "HTTP 200") || !strings.Contains(r.out, "Caitlyn-Request-Id") {
		t.Fatalf("--include: %s", r.out)
	}
}

func TestChat(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "chat", agentID+"@draft", "How much annual leave?", "-o", "jsonl")
	if r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	var sawText, sawCompleted bool
	for _, line := range strings.Split(strings.TrimSpace(r.out), "\n") {
		var ev struct {
			Type string `json:"type"`
		}
		if json.Unmarshal([]byte(line), &ev) != nil {
			t.Fatalf("not JSON Lines: %q", line)
		}
		sawText = sawText || ev.Type == "text.delta"
		sawCompleted = sawCompleted || ev.Type == "message.completed"
	}
	if !sawText || !sawCompleted {
		t.Fatalf("every event in JSON Lines:\n%s", r.out)
	}
	r = run(t, nil, "", "chat", agentID+"@draft", "How much annual leave?", "-o", "text")
	if r.code != 0 || !strings.Contains(r.out, "Sources") || !strings.Contains(r.out, "leave-policy.pdf, page 3") {
		t.Fatalf("text: the answer, then the sources:\n%s\n%s", r.out, r.errOut)
	}
	// stdin as the message
	r = run(t, nil, "Is there a carry-over limit?\n", "chat", agentID+"@draft", "-", "-o", "jsonl")
	if r.code != 0 {
		t.Fatalf("stdin message: %d %s", r.code, r.errOut)
	}
}

func TestEventsTailCheckpoint(t *testing.T) {
	reset(t)
	cp := filepath.Join(t.TempDir(), "events.cursor")
	r := run(t, nil, "", "events", "tail", "--type", "conversation.created", "--checkpoint", cp, "--until-match", "true", "--timeout", "15s", "-o", "jsonl")
	if r.code != 0 && r.code != 9 {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	if !strings.Contains(r.errOut, "Listening") {
		t.Fatalf("Listening. is printed once the stream is open: %s", r.errOut)
	}
	if r.code == 0 {
		if b, err := os.ReadFile(cp); err != nil || strings.TrimSpace(string(b)) == "" {
			t.Fatalf("the checkpoint holds the last event's id: %v %q", err, b)
		}
	}
	if r := run(t, nil, "", "events", "tail"); r.code != 2 {
		t.Fatalf("no filter is a usage error: %d", r.code)
	}
}

func TestKBSync(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "leave-policy.pdf"), []byte("%PDF-1.4 leave"), 0o644)
	os.MkdirAll(filepath.Join(dir, "hr"), 0o755)
	os.WriteFile(filepath.Join(dir, "hr", "pay.pdf"), []byte("%PDF-1.4 pay"), 0o644)
	r := run(t, nil, "", "kb", "sync", kbID, dir, "--folder", "/handbook/", "--yes", "--timeout", "60s", "-o", "json")
	if r.code != 0 {
		t.Fatalf("exit %d:\nstdout %s\nstderr %s", r.code, r.out, r.errOut)
	}
	var report struct {
		Items []map[string]any `json:"Items"`
	}
	if err := json.Unmarshal([]byte(r.out), &report); err != nil {
		t.Fatalf("the report as JSON: %v\n%s", err, r.out)
	}
	if len(report.Items) != 2 {
		t.Fatalf("two items: %s", r.out)
	}
	// without a terminal or --yes, applying a plan that changes things needs an answer: exit 3
	os.WriteFile(filepath.Join(dir, "new.pdf"), []byte("%PDF-1.4 new"), 0o644)
	r = run(t, nil, "", "kb", "sync", kbID, dir, "--folder", "/handbook/", "--timeout", "60s")
	if r.code != 3 {
		t.Fatalf("no --yes: exit %d %s", r.code, r.errOut)
	}
}

func TestDocumentCreateUploadsTheFile(t *testing.T) {
	reset(t)
	file := filepath.Join(t.TempDir(), "leave.pdf")
	os.WriteFile(file, []byte("%PDF-1.4 hello"), 0o644)
	r := run(t, nil, "", "kb", "documents", "create", file, "--kb", kbID, "--folder", "/policies/", "-o", "json")
	if r.code != 0 {
		t.Fatalf("exit %d: %s %s", r.code, r.out, r.errOut)
	}
	r = run(t, nil, "", "kb", "documents", "create", file, "--kb", kbID, "--folder", "/policies/", "--wait", "--timeout", "30s", "-o", "json")
	if r.code != 0 || !strings.Contains(r.out, `"folder"`) {
		t.Fatalf("--wait prints the document once processed: %d %s %s", r.code, r.out, r.errOut)
	}
}

func TestDraftDiffAndApply(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft")
	if r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	if r := run(t, nil, "", "diff", "-f", dir, "--fail-on", "changes", "-o", "json"); r.code != 0 {
		t.Fatalf("an unchanged export has no changes: %d %s %s", r.code, r.out, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "configuration:") {
		t.Fatalf("the export holds the version:\n%s", b)
	}
	edited := strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Quote the clause.", 1)
	os.WriteFile(path, []byte(edited), 0o644)
	r = run(t, nil, "", "diff", "-f", dir, "--fail-on", "changes", "-o", "json")
	if r.code != 3 || !strings.Contains(r.out, "guidance.instructions") {
		t.Fatalf("--fail-on changes exits 3 and names the member: %d %s", r.code, r.out)
	}
	if r := run(t, nil, "", "apply", "-f", dir); r.code != 3 {
		t.Fatalf("apply asks first; no terminal and no --yes is exit 3: %d %s", r.code, r.errOut)
	}
	if r := run(t, nil, "", "apply", "-f", dir, "--yes"); r.code != 0 {
		t.Fatalf("apply: %d %s", r.code, r.errOut)
	}
	// the draft is the file now, but live isn't: unpublished, which --fail-on changes counts
	if r := run(t, nil, "", "diff", "-f", dir, "--fail-on", "changes", "-o", "json"); r.code != 3 || !strings.Contains(r.out, `"changes":null`) || !strings.Contains(r.out, `"unpublished":true`) {
		t.Fatalf("after apply, no draft changes but an unpublished draft: %d %s", r.code, r.out)
	}
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-1"); r.code != 0 {
		t.Fatalf("apply --publish: %d %s", r.code, r.errOut)
	}
	if r := run(t, nil, "", "diff", "-f", dir, "--fail-on", "changes"); r.code != 0 {
		t.Fatalf("after publishing, nothing to change: %d %s", r.code, r.out)
	}
	// the manifest pins its workspace
	r = run(t, map[string]string{"CAITLYN_WORKSPACE": "other.caitlyn.ai"}, "", "diff", "-f", dir)
	if r.code != 2 {
		t.Fatalf("another workspace is refused: %d %s", r.code, r.errOut)
	}
}

func TestConfigCommands(t *testing.T) {
	home := t.TempDir()
	env := map[string]string{"CAITLYN_CONFIG_DIR": filepath.Join(home, ".caitlyn")}
	if r := run(t, env, "", "config", "set", "output", "yaml"); r.code != 0 {
		t.Fatalf("set: %d %s", r.code, r.errOut)
	}
	r := run(t, env, "", "config", "get", "output", "--show-origin")
	if !strings.Contains(r.out, "yaml") || !strings.Contains(r.out, "user") {
		t.Fatalf("get: %q", r.out)
	}
	if r := run(t, env, "", "config", "set", "nonsense", "x"); r.code != 2 {
		t.Fatalf("unknown key: %d", r.code)
	}
	r = run(t, env, "", "config", "list", "-o", "json")
	if r.code != 0 || !strings.Contains(r.out, `"key":"output"`) {
		t.Fatalf("list: %s", r.out)
	}
}

func TestSkewIsCheckedBeforeSending(t *testing.T) {
	reset(t)
	home := t.TempDir()
	dir := filepath.Join(home, ".caitlyn")
	os.MkdirAll(filepath.Join(dir, "cache"), 0o700)
	os.WriteFile(filepath.Join(dir, "cache", "server-default.json"), []byte(`{"version":"5.0.0","at":"2026-11-25T00:00:00Z"}`), 0o600)
	r := run(t, map[string]string{"CAITLYN_CONFIG_DIR": dir}, "", "kb", "get", kbID)
	if r.code != 8 {
		t.Fatalf("an operation newer than the workspace is exit 8: %d %s", r.code, r.errOut)
	}
}

// profileHome writes a user configuration and returns the environment that uses it.
func profileHome(t *testing.T, config string, extra map[string]string) map[string]string {
	t.Helper()
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".caitlyn"), 0o700)
	os.WriteFile(filepath.Join(home, ".caitlyn", "config"), []byte(config), 0o600)
	env := map[string]string{"CAITLYN_CONFIG_DIR": filepath.Join(home, ".caitlyn")}
	for k, v := range extra {
		env[k] = v
	}
	return env
}

func sent(t *testing.T, method string) []map[string]any {
	t.Helper()
	var reqs []map[string]any
	getJSON(t, "/__mock/requests", &reqs)
	var out []map[string]any
	for _, q := range reqs {
		if q["method"] == method {
			out = append(out, q)
		}
	}
	return out
}

// A repository's .caitlyn.toml can't send the person's token to a workspace they never signed in to (the review of
// !92, H1): a project-file workspace that no profile names is refused before anything is sent.
func TestProjectFileCannotRedirectTheToken(t *testing.T) {
	reset(t)
	env := profileHome(t, "[profiles.default]\nworkspace = \"acme.caitlyn.ai\"\n", map[string]string{"CAITLYN_WORKSPACE": ""})
	repo := t.TempDir()
	os.Mkdir(filepath.Join(repo, ".git"), 0o755)
	project := filepath.Join(repo, ".caitlyn.toml")
	os.WriteFile(project, []byte("workspace = \"evil.example.com\"\n"), 0o644)
	r := run(t, env, "", "kb", "list", "--project-file", project)
	if r.code != 2 || !strings.Contains(r.errOut, "CONFIG_INVALID") || !strings.Contains(r.errOut, "evil.example.com") {
		t.Fatalf("a project file's unknown workspace is a configuration error, exit 2: %d %s", r.code, r.errOut)
	}
	if got := sent(t, "GET"); len(got) != 0 {
		t.Fatalf("nothing is sent: %v", got)
	}
	// a workspace a profile names is fine, and --workspace overrides the project file
	os.WriteFile(project, []byte("workspace = \"acme.caitlyn.ai\"\n"), 0o644)
	if r := run(t, env, "", "kb", "list", "--project-file", project); r.code != 0 {
		t.Fatalf("a profile's workspace: %d %s", r.code, r.errOut)
	}
	os.WriteFile(project, []byte("workspace = \"evil.example.com\"\n"), 0o644)
	if r := run(t, env, "", "kb", "list", "--project-file", project, "--workspace", "acme.caitlyn.ai"); r.code != 0 {
		t.Fatalf("--workspace wins: %d %s", r.code, r.errOut)
	}
}

// Every way to write goes through the same check (the review of !92, H2): caitlyn api by name and by path, kb sync
// --remove-missing, apply --publish and chat.
func TestReadOnlyAndAgentScopesCoverEveryWrite(t *testing.T) {
	reset(t)
	agentReadOnly := profileHome(t, "[profiles.default]\nread_only = true\nagent_scopes = \"full\"\n", map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"})
	r := run(t, agentReadOnly, "", "api", "DeleteAgent", "--agent", agentID, "--yes", "--confirm", agentID)
	if r.code != 5 || !strings.Contains(r.errOut, "READ_ONLY_PROFILE") {
		t.Fatalf("api DeleteAgent on a read-only profile: %d %s", r.code, r.errOut)
	}
	r = run(t, agentReadOnly, "", "api", "DELETE", "/v3/agents/"+agentID, "--yes", "--confirm", agentID)
	if r.code != 5 || !strings.Contains(r.errOut, "READ_ONLY_PROFILE") {
		t.Fatalf("api DELETE by path on a read-only profile: %d %s", r.code, r.errOut)
	}
	r = run(t, agentReadOnly, "", "chat", agentID+"@draft", "Hello", "-o", "jsonl")
	if r.code != 5 || !strings.Contains(r.errOut, "READ_ONLY_PROFILE") {
		t.Fatalf("chat writes a conversation, so a read-only profile refuses it: %d %s", r.code, r.errOut)
	}
	if got := sent(t, "DELETE"); len(got) != 0 {
		t.Fatalf("nothing deleted: %v", got)
	}
	if got := sent(t, "POST"); len(got) != 0 {
		t.Fatalf("nothing created: %v", got)
	}
	// reads still work through caitlyn api
	if r := run(t, agentReadOnly, "", "api", "GetKnowledgeBase", "--kb", kbID); r.code != 0 {
		t.Fatalf("a read: %d %s", r.code, r.errOut)
	}

	// default agent scopes (read only): caitlyn api by name and by path are checked like the generated commands
	agent := map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"}
	r = run(t, agent, "", "api", "DeleteAgent", "--agent", agentID, "--yes", "--confirm", agentID)
	if r.code != 5 || !strings.Contains(r.errOut, "AGENT_SCOPE_DENIED") {
		t.Fatalf("api DeleteAgent outside the agent scopes: %d %s", r.code, r.errOut)
	}
	r = run(t, agent, "", "api", "POST", "/v3/agents", "--field", "name=x")
	if r.code != 5 || !strings.Contains(r.errOut, "AGENT_SCOPE_DENIED") {
		t.Fatalf("api POST by path outside the agent scopes: %d %s", r.code, r.errOut)
	}

	// with full agent scopes, a destructive call by name still needs --yes and --confirm
	full := profileHome(t, "[profiles.default]\nagent_scopes = \"full\"\n", map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"})
	r = run(t, full, "", "api", "DeleteAgent", "--agent", agentID, "--yes")
	if r.code != 3 || !strings.Contains(r.errOut, "--confirm") {
		t.Fatalf("api DeleteAgent needs --confirm under an agent: %d %s", r.code, r.errOut)
	}
	r = run(t, full, "", "api", "DELETE", "/v3/agents/"+agentID)
	if r.code != 3 {
		t.Fatalf("api DELETE by path needs --yes under an agent: %d %s", r.code, r.errOut)
	}
	if got := sent(t, "DELETE"); len(got) != 0 {
		t.Fatalf("nothing deleted: %v", got)
	}

	// kb sync --remove-missing deletes documents: refused under read-only agent scopes even with --yes
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "leave-policy.pdf"), []byte("%PDF-1.4 leave"), 0o644)
	r = run(t, agent, "", "kb", "sync", kbID, dir, "--folder", "/handbook/", "--remove-missing", "--yes", "--timeout", "30s")
	if r.code != 5 {
		t.Fatalf("kb sync --remove-missing under read-only agent scopes: %d %s", r.code, r.errOut)
	}
	if got := sent(t, "POST"); len(got) != 0 {
		t.Fatalf("kb sync sent nothing: %v", got)
	}
}

// apply --publish makes a version live: under an agent it needs --confirm naming the agents, and only an
// explicit --publish publishes (the review of !92, M4).
func TestApplyPublishNeedsConfirm(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	b, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Be brief.", 1)), 0o644)
	full := profileHome(t, "[profiles.default]\nagent_scopes = \"full\"\n", map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"})
	r := run(t, full, "", "apply", "-f", dir, "--publish", "--name", "december-release", "--yes")
	if r.code != 3 || !strings.Contains(r.errOut, "--confirm") {
		t.Fatalf("apply --publish needs --confirm under an agent: %d %s", r.code, r.errOut)
	}
	if got := sent(t, "PUT"); len(got) != 0 {
		t.Fatalf("nothing written before the check: %v", got)
	}
	// a project file can't turn publishing on
	project := filepath.Join(t.TempDir(), ".caitlyn.toml")
	os.WriteFile(project, []byte("[apply]\npublish = true\n"), 0o644)
	r = run(t, nil, "", "apply", "-f", dir, "--yes", "--project-file", project)
	if r.code != 0 && r.code != 2 {
		t.Fatalf("apply: %d %s", r.code, r.errOut)
	}
	var reqs []map[string]any
	getJSON(t, "/__mock/requests", &reqs)
	for _, q := range reqs {
		if p, _ := q["path"].(string); strings.Contains(p, ":publish") || strings.HasSuffix(p, "/publish") {
			t.Fatalf("a project file published: %v", q)
		}
	}
}

// A project file's profile can't loosen anything (the review of !92, round 2, H1): a profile the user file doesn't
// have is refused, and one it does have gives the stricter of its read_only and agent_scopes and the person's own.
func TestProjectFileProfileCannotLoosen(t *testing.T) {
	reset(t)
	user := "[profiles.default]\nworkspace = \"your-company.caitlyn.ai\"\nread_only = true\nagent_scopes = [\"none\"]\n\n" +
		"[profiles.admin]\nworkspace = \"your-company.caitlyn.ai\"\nagent_scopes = [\"full\"]\n"
	project := filepath.Join(t.TempDir(), ".caitlyn.toml")

	// a profile that doesn't exist: refused, nothing sent
	os.WriteFile(project, []byte("profile = \"nope\"\nworkspace = \"your-company.caitlyn.ai\"\n"), 0o644)
	r := run(t, profileHome(t, user, nil), "", "agents", "delete", agentID, "--yes", "--project-file", project)
	if r.code != 2 || !strings.Contains(r.errOut, "CONFIG_INVALID") || !strings.Contains(r.errOut, "nope") {
		t.Fatalf("an unknown project-file profile is refused: %d %s", r.code, r.errOut)
	}

	// an existing profile with more access: the person's own read_only and agent_scopes still hold
	os.WriteFile(project, []byte("profile = \"admin\"\n"), 0o644)
	r = run(t, profileHome(t, user, nil), "", "agents", "delete", agentID, "--yes", "--project-file", project)
	if r.code != 5 || !strings.Contains(r.errOut, "READ_ONLY_PROFILE") {
		t.Fatalf("read_only still holds: %d %s", r.code, r.errOut)
	}
	r = run(t, profileHome(t, user, map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"}), "", "kb", "list", "--project-file", project)
	if r.code != 5 || !strings.Contains(r.errOut, "AGENT_NOT_ALLOWED") {
		t.Fatalf("agent_scopes none still holds: %d %s", r.code, r.errOut)
	}
	// choosing by workspace (admin sorts first) is the same
	os.WriteFile(project, []byte("workspace = \"your-company.caitlyn.ai\"\n"), 0o644)
	r = run(t, profileHome(t, user, map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1", "CAITLYN_WORKSPACE": ""}), "", "kb", "list", "--project-file", project)
	if r.code != 5 || !strings.Contains(r.errOut, "AGENT_NOT_ALLOWED") {
		t.Fatalf("a workspace-chosen profile is no looser: %d %s", r.code, r.errOut)
	}
	if got := sent(t, "DELETE"); len(got) != 0 {
		t.Fatalf("nothing deleted: %v", got)
	}
	// --profile is the person's own choice, and isn't tightened
	r = run(t, profileHome(t, user, nil), "", "kb", "list", "--profile", "admin", "--project-file", project)
	if r.code != 0 {
		t.Fatalf("--profile admin: %d %s", r.code, r.errOut)
	}
}

// A destructive command doesn't take its target from the project file (round 2, L5).
func TestDestructiveTargetNotFromProjectFile(t *testing.T) {
	reset(t)
	project := filepath.Join(t.TempDir(), ".caitlyn.toml")
	os.WriteFile(project, []byte("knowledge_base = \""+kbID+"\"\nagent = \""+agentID+"\"\n"), 0o644)
	r := run(t, nil, "", "agents", "delete", "--yes", "--project-file", project)
	if r.code != 2 {
		t.Fatalf("agents delete with its agent only in the project file is a usage error: %d %s", r.code, r.errOut)
	}
	if r := run(t, nil, "", "kb", "documents", "list", "--project-file", project); r.code != 0 {
		t.Fatalf("a read still takes the project file's knowledge base: %d %s", r.code, r.errOut)
	}
}

// The environment never loosens a profile's safeguards (round 3, M1): CAITLYN_READ_ONLY only tightens, and
// agent_scopes never comes from the environment.
func TestEnvironmentCannotLoosen(t *testing.T) {
	reset(t)
	user := "[profiles.default]\nread_only = true\nagent_scopes = [\"none\"]\n"
	r := run(t, profileHome(t, user, map[string]string{"CAITLYN_READ_ONLY": "false"}), "", "agents", "delete", agentID, "--yes")
	if r.code != 5 || !strings.Contains(r.errOut, "READ_ONLY_PROFILE") {
		t.Fatalf("CAITLYN_READ_ONLY=false lifted read_only: %d %s", r.code, r.errOut)
	}
	r = run(t, profileHome(t, user, map[string]string{"CAITLYN_READ_ONLY": "0", "CAITLYN_AGENT_SCOPES": "full", "CLAUDE_CODE_CHILD_SESSION": "1"}), "", "agents", "delete", agentID, "--yes", "--confirm", agentID)
	if r.code != 5 {
		t.Fatalf("CAITLYN_AGENT_SCOPES=full lifted agent_scopes none: %d %s", r.code, r.errOut)
	}
	r = run(t, profileHome(t, user, map[string]string{"CAITLYN_AGENT_SCOPES": "full"}), "", "config", "get", "agent_scopes")
	if strings.Contains(r.out, "full") {
		t.Fatalf("config get agent_scopes read the environment: %s", r.out)
	}
	if got := sent(t, "DELETE"); len(got) != 0 {
		t.Fatalf("nothing deleted: %v", got)
	}
	// and it still tightens
	r = run(t, map[string]string{"CAITLYN_READ_ONLY": "true"}, "", "agents", "delete", agentID, "--yes")
	if r.code != 5 || !strings.Contains(r.errOut, "READ_ONLY_PROFILE") {
		t.Fatalf("CAITLYN_READ_ONLY=true: %d %s", r.code, r.errOut)
	}
}

// A retried apply --publish publishes what a failed run left unpublished (round 3, M2), and a file with a member
// this CLI doesn't know is refused before anything is written (M3).
func TestApplyPublishRetryAndUnknownMembers(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	b, _ := os.ReadFile(path)
	// a first publish, so the draft is based on live
	os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Quote it.", 1)), 0o644)
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-0"); r.code != 0 {
		t.Fatalf("first publish: %d %s", r.code, r.errOut)
	}
	os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Be brief.", 1)), 0o644)
	faults(t, map[string]any{"status": map[string]any{"PublishAgentVersion": []map[string]any{{"status": 503}}}})
	r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-1")
	if r.code == 0 {
		t.Fatalf("the publish failed, so apply fails: %s", r.errOut)
	}
	r = run(t, nil, "", "diff", "-f", dir, "-o", "json")
	if !strings.Contains(r.out, `"publishable":true`) {
		t.Fatalf("the draft written but not published is publishable:\n%s", r.out)
	}
	r = run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2")
	if r.code != 0 || !strings.Contains(r.errOut+r.out, "Published the draft of "+agentID) {
		t.Fatalf("the retry publishes it: %d %s %s", r.code, r.out, r.errOut)
	}
	r = run(t, nil, "", "diff", "-f", dir, "-o", "json")
	if strings.Contains(r.out, `"publishable":true`) {
		t.Fatalf("after publishing, nothing is publishable:\n%s", r.out)
	}

	// an unknown top-level member: refused by diff and apply, nothing written
	b, _ = os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(b), "configuration:\n", "configuration:\n  guidence:\n    instructions: typo\n", 1)), 0o644)
	reset(t)
	for _, args := range [][]string{{"diff", "-f", dir}, {"apply", "-f", dir, "--yes"}} {
		r := run(t, nil, "", args...)
		if r.code != 2 || !strings.Contains(r.errOut, "CONFIG_INVALID") || !strings.Contains(r.errOut, "guidence") {
			t.Fatalf("%v with an unknown member: %d %s", args, r.code, r.errOut)
		}
	}
	if got := sent(t, "PUT"); len(got) != 0 {
		t.Fatalf("nothing written: %v", got)
	}
}

// kb sync --remove-missing names its knowledge base on the command line, and confirms it in CI (round 3, L2).
func TestSyncRemoveMissingNamesTheKnowledgeBase(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "leave-policy.pdf"), []byte("%PDF-1.4 leave"), 0o644)
	project := filepath.Join(t.TempDir(), ".caitlyn.toml")
	os.WriteFile(project, []byte("knowledge_base = \""+kbID+"\"\n"), 0o644)
	r := run(t, nil, "", "kb", "sync", dir, "--remove-missing", "--yes", "--project-file", project)
	if r.code != 2 || !strings.Contains(r.errOut, "--remove-missing") {
		t.Fatalf("a project-file knowledge base with --remove-missing: %d %s", r.code, r.errOut)
	}
	ci := map[string]string{"GITLAB_CI": "true", "CI": "true"}
	r = run(t, ci, "", "kb", "sync", kbID, dir, "--remove-missing", "--yes", "--timeout", "30s")
	if r.code != 3 || !strings.Contains(r.errOut, "--confirm") {
		t.Fatalf("in CI --remove-missing needs --confirm: %d %s", r.code, r.errOut)
	}
	r = run(t, ci, "", "kb", "sync", kbID, dir, "--remove-missing", "--yes", "--confirm", kbID, "--timeout", "30s")
	if r.code != 0 {
		t.Fatalf("with --confirm: %d %s", r.code, r.errOut)
	}
}

// apply --publish never undoes a rollback (round 4, M1): a draft that matches the files but isn't based on live is
// left alone, and an unpublished draft is shown in the plan before it is published.
func TestApplyPublishLeavesARollback(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	b, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Be brief.", 1)), 0o644)
	r := run(t, nil, "", "agents", "versions", "get", agentID+"@live", "--jq", ".liveVersion")
	before := strings.TrimSpace(r.out)
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-1"); r.code != 0 {
		t.Fatalf("apply --publish: %d %s", r.code, r.errOut)
	}
	// roll back to the version live pointed at before
	if before == "" || before == "null" {
		t.Skipf("the mock's agent has no live version to roll back to (%q)", before)
	}
	if r := run(t, nil, "", "agents", "versions", "publish", agentID+"@"+before, "--yes"); r.code != 0 {
		t.Fatalf("roll back: %d %s", r.code, r.errOut)
	}
	r = run(t, nil, "", "diff", "-f", dir, "-o", "json")
	if strings.Contains(r.out, `"publishable":true`) || !strings.Contains(r.out, `"rolledBack":"`+before+` on `) {
		t.Fatalf("a rolled-back agent isn't publishable, and the plan says live was rolled back:\n%s", r.out)
	}
	// the plan says so, and apply --publish leaves live where it is
	r = run(t, nil, "", "diff", "-f", dir, "-o", "table")
	if !strings.Contains(r.out+r.errOut, "live was rolled back to "+before+" on ") || !strings.Contains(r.out+r.errOut, "--publish-over-rollback") {
		t.Fatalf("the plan explains the rollback:\n%s%s", r.out, r.errOut)
	}
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2"); r.code != 0 || strings.Contains(r.errOut+r.out, "Published") {
		t.Fatalf("apply --publish leaves a rollback alone: %d %s %s", r.code, r.out, r.errOut)
	}
	reset(t)
}

// While live's newest change is a rollback, apply --publish never publishes the agent, whatever else the file
// changes (round 7, M1): a bad change is published, rolled back, then an unrelated tweak lands in the file, and CI's
// apply --publish writes the draft but leaves live on the rollback. The plan, the MR note and --dry-run say why and
// name --publish-over-rollback.
func TestApplyPublishHoldsARolledBackAgentWhateverChanges(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	orig, _ := os.ReadFile(path)
	before := strings.TrimSpace(run(t, nil, "", "agents", "versions", "get", agentID+"@live", "--jq", ".liveVersion").out)
	if before == "" || before == "null" {
		t.Skipf("the mock's agent has no live version to roll back to (%q)", before)
	}
	os.WriteFile(path, []byte(strings.Replace(string(orig), "Answer from the HR policies.", "Answer from the HR policies. BAD CHANGE.", 1)), 0o644)
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "bad-change"); r.code != 0 {
		t.Fatalf("apply --publish: %d %s", r.code, r.errOut)
	}
	if r := run(t, nil, "", "agents", "versions", "publish", agentID+"@"+before, "--yes"); r.code != 0 {
		t.Fatalf("roll back: %d %s", r.code, r.errOut)
	}
	// an unrelated tweak on top of the bad change: the file is now content live has never had
	os.WriteFile(path, []byte(strings.Replace(string(orig), "Answer from the HR policies.", "Answer from the HR policies. BAD CHANGE. Be brief.", 1)), 0o644)
	ci := map[string]string{"GITLAB_CI": "true", "CI": "true"}
	note := filepath.Join(t.TempDir(), "note.md")
	run(t, ci, "", "diff", "-f", dir, "--report", "markdown="+note)
	if b, _ := os.ReadFile(note); !strings.Contains(string(b), "live was rolled back to "+before) || !strings.Contains(string(b), "--publish-over-rollback") {
		t.Fatalf("the MR note says why and names the flag:\n%s", b)
	}
	r := run(t, ci, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2", "--dry-run")
	if !strings.Contains(r.out+r.errOut, "live was rolled back to "+before) || !strings.Contains(r.out+r.errOut, "--publish-over-rollback") {
		t.Fatalf("--dry-run says why and names the flag: %s %s", r.out, r.errOut)
	}
	r = run(t, ci, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2")
	if r.code != 0 || strings.Contains(r.out+r.errOut, "Published the draft") || !strings.Contains(r.out+r.errOut, "--publish-over-rollback") {
		t.Fatalf("CI's apply --publish writes the draft and leaves live on the rollback, saying why: %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	if now := strings.TrimSpace(run(t, nil, "", "agents", "versions", "get", agentID+"@live", "--jq", ".liveVersion").out); now != before {
		t.Fatalf("live moved from %s to %s", before, now)
	}
	reset(t)
}

// An unpublished draft is shown, counted by --fail-on changes, and named in the plan (round 4, M1).
func TestUnpublishedDraftIsShown(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	b, _ := os.ReadFile(path)
	// publish once, so the draft is based on live
	os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. One.", 1)), 0o644)
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-1"); r.code != 0 {
		t.Fatalf("apply --publish: %d %s", r.code, r.errOut)
	}
	// write a draft without publishing it
	os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Two.", 1)), 0o644)
	if r := run(t, nil, "", "apply", "-f", dir, "--yes"); r.code != 0 {
		t.Fatalf("apply: %d %s", r.code, r.errOut)
	}
	r := run(t, nil, "", "diff", "-f", dir, "--fail-on", "changes")
	if r.code != 3 || !strings.Contains(r.out, `"unpublished":true`) {
		t.Fatalf("an unpublished draft is a change, and is shown: %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	r = run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2", "--dry-run")
	if !strings.Contains(r.errOut+r.out, "draft unpublished: it matches the file, live (release-1) doesn't") {
		t.Fatalf("--dry-run shows what --publish would publish:\n%s\n%s", r.out, r.errOut)
	}
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2"); r.code != 0 || !strings.Contains(r.errOut+r.out, "Published the draft of "+agentID) {
		t.Fatalf("publishes it: %d %s %s", r.code, r.out, r.errOut)
	}
	reset(t)
}

// config unset resolves its key as set does (round 4, M2), and an unknown --profile has no fewer safeguards than
// the person's own profile (round 4, L1).
func TestConfigUnsetAndUnknownProfiles(t *testing.T) {
	reset(t)
	user := "[profiles.default]\nworkspace = \"your-company.caitlyn.ai\"\nread_only = true\nagent_scopes = \"none\"\n"
	agent := map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"}
	env := profileHome(t, user, agent)
	for _, key := range []string{"profiles.default.read_only", "profiles.default.agent_scopes", "read_only"} {
		r := run(t, env, "", "config", "unset", key)
		if r.code == 0 {
			t.Fatalf("config unset %s under an agent succeeded", key)
		}
	}
	b, _ := os.ReadFile(filepath.Join(env["CAITLYN_CONFIG_DIR"], "config"))
	if !strings.Contains(string(b), "read_only = true") || !strings.Contains(string(b), "agent_scopes") {
		t.Fatalf("the file changed:\n%s", b)
	}
	// --profile ghost and CAITLYN_PROFILE=ghost keep the default profile's safeguards
	r := run(t, profileHome(t, user, nil), "", "agents", "delete", agentID, "--yes", "--profile", "ghost")
	if r.code != 5 || !strings.Contains(r.errOut, "READ_ONLY_PROFILE") {
		t.Fatalf("--profile ghost lifted read_only: %d %s", r.code, r.errOut)
	}
	r = run(t, profileHome(t, user, map[string]string{"CAITLYN_PROFILE": "ghost", "CLAUDE_CODE_CHILD_SESSION": "1"}), "", "kb", "list")
	if r.code != 5 || !strings.Contains(r.errOut, "AGENT_NOT_ALLOWED") {
		t.Fatalf("CAITLYN_PROFILE=ghost lifted agent_scopes none: %d %s", r.code, r.errOut)
	}
	if got := sent(t, "DELETE"); len(got) != 0 {
		t.Fatalf("nothing deleted: %v", got)
	}
}

// A nested member the model doesn't have is refused by the server, not dropped (round 4, L5).
func TestNestedUnknownMemberIsRefused(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	b, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(b), "instructions:", "instrucions: typo\n    instructions:", 1)), 0o644)
	r := run(t, nil, "", "apply", "-f", dir, "--yes")
	if r.code == 0 {
		t.Fatalf("a nested unknown member was accepted:\n%s\n%s", r.out, r.errOut)
	}
	reset(t)
}

// A draft written but never published, on a server that records no link from the draft to its publishes (the
// draft's basedOn only follows a reset), is still published by a retry (round 5, M1).
func TestRetryPublishesWithoutBasedOn(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	b, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Retry me.", 1)), 0o644)
	faults(t, map[string]any{"status": map[string]any{"PublishAgentVersion": []map[string]any{{"status": 503}}}})
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-1"); r.code == 0 {
		t.Fatalf("the publish failed, so apply fails")
	}
	r := run(t, nil, "", "agents", "draft", "get", agentID, "--jq", ".basedOn // \"\"")
	if strings.TrimSpace(r.out) != `""` && strings.TrimSpace(r.out) != "" {
		t.Fatalf("this case is a draft with no basedOn: %q", r.out)
	}
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-1"); r.code != 0 || !strings.Contains(r.errOut+r.out, "Published the draft of "+agentID) {
		t.Fatalf("the retry publishes it: %d %s %s", r.code, r.out, r.errOut)
	}
	reset(t)
}

// A rollback stays rolled back after the draft is reset from live (round 6, M1): the file's content was published
// before, so apply --publish writes the draft but leaves live alone, says so, and --publish-over-rollback overrides.
func TestApplyPublishKeepsARollbackAfterAReset(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
		t.Fatalf("export: %d %s", r.code, r.errOut)
	}
	path := filepath.Join(dir, "agents", agentID+".yaml")
	b, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Be brief.", 1)), 0o644)
	before := strings.TrimSpace(run(t, nil, "", "agents", "versions", "get", agentID+"@live", "--jq", ".liveVersion").out)
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-1"); r.code != 0 {
		t.Fatalf("apply --publish: %d %s", r.code, r.errOut)
	}
	// roll live back, then reset the draft from live: the draft no longer matches the file
	if r := run(t, nil, "", "agents", "versions", "publish", agentID+"@"+before, "--yes"); r.code != 0 {
		t.Fatalf("roll back: %d %s", r.code, r.errOut)
	}
	etag := strings.TrimSpace(run(t, nil, "", "agents", "draft", "get", agentID, "--jq", ".etag").out)
	if r := run(t, nil, "", "agents", "draft", "reset", agentID, "--from", "live", "--if-match", etag, "--yes"); r.code != 0 {
		t.Fatalf("reset the draft from live: %d %s", r.code, r.errOut)
	}
	r := run(t, nil, "", "diff", "-f", dir, "-o", "json")
	if !strings.Contains(r.out, `"publishable":false`) || !strings.Contains(r.out, `"rolledBack":"`+before) || strings.Contains(r.out, `"changes":null`) {
		t.Fatalf("a draft change, held back from publishing because of the rollback:\n%s", r.out)
	}
	r = run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2")
	if r.code != 0 || strings.Contains(r.out+r.errOut, "Published the draft") || !strings.Contains(r.out+r.errOut, "--publish leaves it alone") {
		t.Fatalf("the draft is written, live is left on the rollback, and the plan says why: %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	if now := strings.TrimSpace(run(t, nil, "", "agents", "versions", "get", agentID+"@live", "--jq", ".liveVersion").out); now != before {
		t.Fatalf("live moved from %s to %s", before, now)
	}
	// on purpose: it needs --confirm under an AI agent, then publishes
	full := profileHome(t, "[profiles.default]\nagent_scopes = \"full\"\n", map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"})
	if r := run(t, full, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2", "--publish-over-rollback"); r.code != 3 || !strings.Contains(r.errOut, "--confirm") {
		t.Fatalf("--publish-over-rollback needs --confirm under an agent: %d %s", r.code, r.errOut)
	}
	r = run(t, full, "", "apply", "-f", dir, "--publish", "--name", "release-2", "--publish-over-rollback", "--note", "fix forward")
	if want := "caitlyn apply --file " + dir + " --name release-2 --note 'fix forward' --publish --publish-over-rollback --yes --confirm " + agentID; r.code != 3 || !strings.Contains(r.errOut, want) {
		t.Fatalf("the suggested command keeps the flags given (%s): %d %s", want, r.code, r.errOut)
	}
	// with the flag, the plan still shows the rollback it publishes over
	if r := run(t, nil, "", "apply", "-f", dir, "--publish", "--name", "release-2", "--publish-over-rollback", "--dry-run"); !strings.Contains(r.out+r.errOut, "publishes over the rollback") {
		t.Fatalf("--publish-over-rollback still shows the rollback: %s %s", r.out, r.errOut)
	}
	if r := run(t, nil, "", "apply", "-f", dir, "--yes", "--publish", "--name", "release-2", "--publish-over-rollback"); r.code != 0 || !strings.Contains(r.out+r.errOut, "Published the draft of "+agentID) {
		t.Fatalf("--publish-over-rollback publishes it: %d %s %s", r.code, r.out, r.errOut)
	}
	if r := run(t, nil, "", "apply", "-f", dir, "--publish-over-rollback"); r.code != 2 {
		t.Fatalf("--publish-over-rollback without --publish is a usage error: %d", r.code)
	}
	reset(t)
}

// config list shows profile once, and its output goes through the printer like every other command's: -o yaml and
// --jq work (round 7, L6).
func TestConfigListProfileOnceAndFilters(t *testing.T) {
	r := run(t, nil, "", "config", "list", "-o", "json")
	if r.code != 0 || strings.Count(r.out, `"key":"profile"`)+strings.Count(r.out, `"key": "profile"`) != 1 {
		t.Fatalf("profile once: %d\n%s", r.code, r.out)
	}
	r = run(t, nil, "", "config", "list", "--jq", `.[] | select(.key == "profile") | .value`)
	if r.code != 0 || strings.TrimSpace(r.out) != "default" {
		t.Fatalf("--jq works: %d %q %s", r.code, r.out, r.errOut)
	}
	r = run(t, nil, "", "config", "list", "-o", "yaml")
	if r.code != 0 || !strings.Contains(r.out, "key: profile") {
		t.Fatalf("-o yaml works: %d\n%s", r.code, r.out)
	}
}

// version --json --jq picks out a signing key, as install.md's key comparison runs it (round 7, L8).
func TestVersionJQSigningKey(t *testing.T) {
	r := run(t, nil, "", "version", "--json", "--jq", ".signingKeys.minisign")
	if r.code != 0 || strings.Contains(r.out, "{") || strings.TrimSpace(r.out) == "" {
		t.Fatalf("version --jq prints the key alone: %d %q %s", r.code, r.out, r.errOut)
	}
}

// The user agent carries the CLI as app/, and the CI system and AI agent as their own ci/ and agent/ tokens, the
// same bytes as when they were packed into app/ (SDK !93's core.WithCI and core.WithAgent).
func TestUserAgentDeclaresCIAndAgent(t *testing.T) {
	reset(t)
	env := map[string]string{"GITLAB_CI": "true", "CI": "true", "CLAUDE_CODE_CHILD_SESSION": "1"}
	if r := run(t, env, "", "agents", "list"); r.code != 0 {
		t.Fatalf("agents list: %d %s", r.code, r.errOut)
	}
	var reqs []map[string]any
	getJSON(t, "/__mock/requests", &reqs)
	for _, q := range reqs {
		h, _ := q["headers"].(map[string]any)
		ua, _ := h["user-agent"].(string)
		if strings.HasPrefix(fmt.Sprint(q["path"]), "/v3/agents") {
			if !regexp.MustCompile(` app/caitlyn-cli#\S+ ci/gitlab agent/claude-code$`).MatchString(ua) {
				t.Fatalf("user agent %q", ua)
			}
			return
		}
	}
	t.Fatalf("no agents request in %v", reqs)
}
