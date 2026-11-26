package describe_test

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/describe"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/shellwords"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

var registerOnce sync.Once

// register wires every package's commands in, once for the whole test binary (as main does once per run).
func register() { registerOnce.Do(commands.Register) }

// result is one run of the CLI.
type result struct {
	code        int
	out, errOut string
}

// run runs the CLI with args against fake streams, in a temporary home and working folder. env is KEY=value pairs.
func run(t *testing.T, env []string, tty bool, args ...string) result {
	t.Helper()
	register()
	io, out, errOut := iostreams.Test("")
	io.Environ = env
	io.SetTTY(tty, tty, tty)
	home, work := t.TempDir(), t.TempDir()
	code := root.Run(context.Background(), io, args, func(f *cmdutil.Factory) {
		f.Home, f.WorkDir = home, work
	})
	return result{code: code, out: out.String(), errOut: errOut.String()}
}

// runIn is run with a working folder the test keeps.
func runIn(t *testing.T, work string, env []string, args ...string) result {
	t.Helper()
	register()
	io, out, errOut := iostreams.Test("")
	io.Environ = env
	home := t.TempDir()
	code := root.Run(context.Background(), io, args, func(f *cmdutil.Factory) {
		f.Home, f.WorkDir = home, work
	})
	return result{code: code, out: out.String(), errOut: errOut.String()}
}

// tree builds the root command and describes it, every command included.
func tree(t *testing.T, env ...string) (*describe.Tree, *cobra.Command, *cmdutil.Factory) {
	t.Helper()
	register()
	io, _, _ := iostreams.Test("")
	io.Environ = env
	m := spec.MustLoad()
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Version: m.Version, Now: time.Now, Home: t.TempDir(), WorkDir: t.TempDir()}
	u := ui.New(io)
	r, err := root.New(f, &u)
	if err != nil {
		t.Fatal(err)
	}
	return describe.Build(r, f, describe.Options{IncludeHidden: true}), r, f
}

func decode(t *testing.T, s string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(s), v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, s)
	}
}

func TestEveryManifestCommandIsDescribed(t *testing.T) {
	tr, _, _ := tree(t)
	m := spec.MustLoad()
	for _, c := range m.Commands {
		d := tr.Find(c.Path)
		if d == nil {
			t.Errorf("caitlyn %s is not in the tree", c.Name())
			continue
		}
		if !d.Generated || d.Kind != "command" {
			t.Errorf("caitlyn %s: generated=%v kind=%s", c.Name(), d.Generated, d.Kind)
		}
		if d.Operation != c.Operation {
			t.Errorf("caitlyn %s: operation %q, want %q", c.Name(), d.Operation, c.Operation)
		}
		if d.Impact == "" {
			t.Errorf("caitlyn %s has no impact class", c.Name())
		}
		if !strings.HasPrefix(d.Docs, "https://build.caitlyn.ai/cli/reference/") {
			t.Errorf("caitlyn %s: docs %s", c.Name(), d.Docs)
		}
		if op := m.Op(c.Operation); op != nil {
			for code := range op.Codes() {
				found := false
				for _, e := range d.Errors {
					found = found || e.Code == code
				}
				if !found {
					t.Errorf("caitlyn %s: error code %s missing", c.Name(), code)
				}
			}
		}
		// Every exit code an error can end it with is listed
		for _, e := range d.Errors {
			if !containsInt(d.ExitCodes, e.ExitCode) {
				t.Errorf("caitlyn %s: %s ends it with %d, which its exit codes leave out", c.Name(), e.Code, e.ExitCode)
			}
		}
	}
}

func containsInt(l []int, n int) bool {
	for _, x := range l {
		if x == n {
			return true
		}
	}
	return false
}

func TestSaveDraftDescribedFromTheModel(t *testing.T) {
	tr, _, _ := tree(t)
	d := tr.Find([]string{"agents", "draft", "save"})
	if d == nil {
		t.Fatal("no agents draft save")
	}
	if d.Impact != "write" || !d.Beta || d.Since == "" || d.Operation != "SaveDraftVersion" {
		t.Errorf("facts: %+v", d)
	}
	if d.Permission == nil || d.Permission.Scope != "agents:write" || d.Permission.Grant != "update on the agent" {
		t.Errorf("permission: %+v", d.Permission)
	}
	if len(d.Args) != 1 || d.Args[0].Name != "agent" || d.Args[0].Identifier != "agentId" || !d.Args[0].Required {
		t.Errorf("args: %+v", d.Args)
	}
	flags := map[string]*describe.Flag{}
	for _, f := range d.Flags {
		flags[f.Name] = f
	}
	name := flags["name"]
	if name == nil || !name.Required || name.Member != "name" || name.Pattern == "" || name.ValueType != "string" {
		t.Errorf("--name: %+v", name)
	}
	for _, want := range []string{"note", "if-match", "idempotency-key"} {
		if flags[want] == nil {
			t.Errorf("no --%s", want)
		}
	}
	if flags["output"] != nil {
		t.Error("a global flag is listed as the command's own")
	}
	if d.Docs != "https://build.caitlyn.ai/cli/reference/agents/draft/#save" {
		t.Errorf("docs %s", d.Docs)
	}
	if d.HTTP == nil || d.HTTP.Method != "POST" || !strings.HasPrefix(d.HTTP.Path, "/api/v3/") {
		t.Errorf("http %+v", d.HTTP)
	}
}

func TestPublishNeedsConfirmAndIsUserFacing(t *testing.T) {
	tr, _, _ := tree(t)
	d := tr.Find([]string{"agents", "versions", "publish"})
	if d.Impact != "user-facing" || d.Confirm != "agent" {
		t.Errorf("impact %s confirm %q", d.Impact, d.Confirm)
	}
	if !containsInt(d.ExitCodes, 3) {
		t.Errorf("a user-facing command can end with 3 (confirmation needed): %v", d.ExitCodes)
	}
	del := tr.Find([]string{"knowledge-bases", "documents", "delete"})
	if del.Impact != "destructive" {
		t.Errorf("delete is %s", del.Impact)
	}
}

func TestKnowledgeBaseFlagAliasAndExamples(t *testing.T) {
	tr, _, _ := tree(t)
	d := tr.Find([]string{"knowledge-bases", "documents", "get"})
	var kb *describe.Flag
	for _, f := range d.Flags {
		if f.Name == "knowledge-base" {
			kb = f
		}
		if f.Name == "kb" {
			t.Error("--kb is listed as a flag of its own, not as --knowledge-base's alias")
		}
	}
	if kb == nil || kb.Identifier != "knowledgeBaseId" || len(kb.Aliases) != 1 || kb.Aliases[0] != "kb" || kb.Env != "CAITLYN_KNOWLEDGE_BASE" {
		t.Errorf("--knowledge-base: %+v", kb)
	}
	kbGroup := tr.Find([]string{"knowledge-bases"})
	if kbGroup.Kind != "group" || len(kbGroup.Aliases) == 0 || kbGroup.Aliases[0] != "kb" {
		t.Errorf("knowledge-bases group: %+v", kbGroup)
	}
	// Every generated command's example line names its own command (hand-written and group examples may show other
	// steps too: TestHelpExamplesAreRealCommands checks those)
	total := 0
	for _, c := range tr.Commands {
		for _, ex := range c.Examples {
			total++
			if c.Generated && !strings.HasPrefix(ex.Line, "caitlyn "+c.Name) {
				t.Errorf("%s: example %q is %q", c.Name, ex.Title, ex.Line)
			}
			if ex.Error != "" && ex.ExitCode == 0 {
				t.Errorf("%s: error example %q has no exit code", c.Name, ex.Title)
			}
		}
	}
	if total < 50 {
		t.Errorf("only %d example lines", total)
	}
}

func TestErrorCodesCarryTheCLIsHint(t *testing.T) {
	tr, _, _ := tree(t)
	pf := tr.Errors["PRECONDITION_FAILED"]
	if pf == nil || pf.ExitCode != 7 || pf.HintFrom != "overlay" || pf.Hint == nil || len(pf.Hint.Next) != 2 {
		t.Fatalf("PRECONDITION_FAILED: %+v", pf)
	}
	if !strings.Contains(pf.Hint.Next[0].Run, " get ") || !strings.HasSuffix(pf.Hint.Next[0].Run, "--query etag") {
		t.Errorf("first step %q", pf.Hint.Next[0].Run)
	}
	if strings.Contains(pf.Hint.Next[0].Run, "'<") {
		t.Errorf("a placeholder is quoted: %q", pf.Hint.Next[0].Run)
	}
	nf := tr.Errors["NOT_FOUND"]
	if nf.ExitCode != 6 || nf.Hint == nil || len(nf.Hint.Next) == 0 || !strings.Contains(nf.Hint.Next[0].Run, " list") {
		t.Errorf("NOT_FOUND: %+v", nf)
	}
	if tr.Errors["UNAUTHENTICATED"].ExitCode != 4 || tr.Errors["RATE_LIMITED"].ExitCode != 11 {
		t.Error("401 and 429 exit codes")
	}
	if tr.Errors["VALIDATION_FAILED"].HintFrom != "fields" {
		t.Error("VALIDATION_FAILED's hint is its field errors, named by flag")
	}
	for code, e := range tr.Errors {
		if len(e.Commands) == 0 {
			t.Errorf("%s lists no command", code)
		}
	}
}

func TestHandWrittenCommandsAppearWithTheirAnnotations(t *testing.T) {
	register()
	tr, r, f := tree(t)
	// Ours are hand-written too
	for _, name := range []string{"commands", "help", "docs", "mcp add"} {
		d := tr.Find(strings.Fields(name))
		if d == nil || d.Generated {
			t.Fatalf("caitlyn %s: %+v", name, d)
		}
	}
	if tr.Find([]string{"mcp", "add"}).Impact != "write" || tr.Find([]string{"commands"}).Impact != "read" {
		t.Error("our own impact annotations")
	}
	// A command another package adds is described without any change here
	extra := &cobra.Command{
		Use:         "frobnicate <kb> [dir]",
		Short:       "Frobnicate a knowledge base",
		Annotations: map[string]string{describe.AnnotationImpact: "destructive", describe.AnnotationExitCodes: "3,6", describe.AnnotationLongRunning: "true", describe.AnnotationOperations: "ListDocuments"},
		RunE:        func(*cobra.Command, []string) error { return nil },
	}
	extra.Flags().Bool("remove-missing", false, "Remove what the folder no longer has")
	r.AddCommand(extra)
	unmarked := &cobra.Command{Use: "unmarked", Short: "No annotations", RunE: func(*cobra.Command, []string) error { return nil }}
	r.AddCommand(unmarked)
	tr = describe.Build(r, f, describe.Options{})
	d := tr.Find([]string{"frobnicate"})
	if d == nil || d.Impact != "destructive" || !d.LongRunning || len(d.Operations) != 1 {
		t.Fatalf("frobnicate: %+v", d)
	}
	if len(d.Args) != 2 || !d.Args[0].Required || d.Args[1].Required {
		t.Errorf("args %+v", d.Args)
	}
	for _, want := range []int{0, 2, 3, 6} {
		if !containsInt(d.ExitCodes, want) {
			t.Errorf("exit codes %v lack %d", d.ExitCodes, want)
		}
	}
	if u := tr.Find([]string{"unmarked"}); u.Impact != "write" {
		t.Errorf("an unannotated hand-written command is %q; it should be treated as a write", u.Impact)
	}
	if tr.Find([]string{"core"}) != nil {
		t.Error("hidden commands are left out without IncludeHidden")
	}
}

func TestCommandsJSON(t *testing.T) {
	res := run(t, nil, false, "commands")
	if res.code != 0 {
		t.Fatalf("exit %d: %s", res.code, res.errOut)
	}
	var tr describe.Tree
	decode(t, res.out, &tr)
	if tr.SchemaVersion != 1 || tr.Agent == nil || len(tr.ExitCodes) != 13 || len(tr.GlobalFlags) == 0 {
		t.Errorf("tree header: schema %d, %d exit codes, %d global flags", tr.SchemaVersion, len(tr.ExitCodes), len(tr.GlobalFlags))
	}
	if tr.Alternatives.MCP.Workspace.Connect != "caitlyn mcp add <client>" || len(tr.Alternatives.MCP.Workspace.BetterFor) == 0 {
		t.Errorf("alternatives.mcp: %+v", tr.Alternatives.MCP)
	}
	if tr.Find([]string{"core", "uploads", "reserve"}) != nil {
		t.Error("core is listed without --hidden")
	}
	// --hidden adds the low-level group; --json and -o json are the same
	res = run(t, nil, true, "commands", "--json", "--hidden")
	decode(t, res.out, &tr)
	if tr.Find([]string{"core", "uploads", "reserve"}) == nil {
		t.Error("--hidden leaves out core")
	}
}

func TestCommandsTreeOnATerminal(t *testing.T) {
	res := run(t, nil, true, "commands")
	if res.code != 0 {
		t.Fatalf("exit %d: %s", res.code, res.errOut)
	}
	if strings.HasPrefix(strings.TrimSpace(res.out), "{") {
		t.Fatal("JSON on a terminal")
	}
	for _, want := range []string{"agents", "\n  draft", "\n    save", "user-facing]", "caitlyn commands --json"} {
		if !strings.Contains(res.out, want) {
			t.Errorf("tree lacks %q", want)
		}
	}
}

func TestCommandsReportAgentMode(t *testing.T) {
	res := run(t, []string{"CAITLYN_AGENT=1"}, false, "commands")
	var tr describe.Tree
	decode(t, res.out, &tr)
	if !tr.Agent.On {
		t.Errorf("agent mode not reported: %+v", tr.Agent)
	}
}

func TestHelpJSONHasTheInputSchema(t *testing.T) {
	res := run(t, nil, false, "help", "agents", "draft", "save", "--format", "json")
	if res.code != 0 {
		t.Fatalf("exit %d: %s", res.code, res.errOut)
	}
	var h struct {
		SchemaVersion int              `json:"schemaVersion"`
		Command       describe.Command `json:"command"`
		InputSchema   map[string]any   `json:"inputSchema"`
		OutputSchema  map[string]any   `json:"outputSchema"`
		GlobalFlags   []describe.Flag  `json:"globalFlags"`
	}
	decode(t, res.out, &h)
	if h.Command.Name != "agents draft save" || h.SchemaVersion != 1 {
		t.Errorf("command %+v", h.Command)
	}
	props, _ := h.InputSchema["properties"].(map[string]any)
	name, _ := props["name"].(map[string]any)
	if name["type"] != "string" || name["pattern"] == nil || name["maxLength"] != float64(63) {
		t.Errorf("name's schema: %v", name)
	}
	if req, _ := h.InputSchema["required"].([]any); len(req) == 0 {
		t.Error("no required members")
	}
	if h.InputSchema["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
		t.Error("no dialect")
	}
	if h.OutputSchema["$ref"] == nil && h.OutputSchema["properties"] == nil {
		t.Errorf("output schema: %v", h.OutputSchema)
	}
	// --help -o json is the same document
	res2 := run(t, nil, false, "agents", "draft", "save", "--help", "-o", "json")
	if res2.code != 0 || res2.out != res.out {
		t.Errorf("--help -o json differs from help --format json (exit %d)", res2.code)
	}
}

func TestHelpMarkdownIsThePageSection(t *testing.T) {
	res := run(t, nil, false, "help", "agents", "draft", "save", "--format", "markdown")
	if res.code != 0 {
		t.Fatalf("exit %d: %s", res.code, res.errOut)
	}
	tr, _, _ := tree(t)
	want := describe.Markdown(tr.Find([]string{"agents", "draft", "save"}), tr, 1)
	if res.out != want {
		t.Errorf("help --format markdown is not the page's Markdown\n--- got\n%s\n--- want\n%s", res.out, want)
	}
	for _, s := range []string{"# caitlyn agents draft save", "\n## Flags\n", "`--name`", "\n## Exit codes\n", "`ALREADY_EXISTS` (409)", "https://build.caitlyn.ai/errors/<CODE>/", "https://build.caitlyn.ai/sdk/save-draft-version/", "https://build.caitlyn.ai/api/save-draft-version/"} {
		if !strings.Contains(res.out, s) {
			t.Errorf("markdown lacks %q", s)
		}
	}
	group := run(t, nil, false, "help", "agents", "draft", "--format", "markdown")
	if !strings.Contains(group.out, "[`caitlyn agents draft save`](https://build.caitlyn.ai/cli/reference/agents/draft/#save)") {
		t.Errorf("a group's Markdown links its commands:\n%s", group.out)
	}
}

func TestHelpTextAndErrors(t *testing.T) {
	res := run(t, nil, false, "help", "agents", "draft", "save")
	if res.code != 0 || !strings.Contains(res.out, "Usage:") {
		t.Errorf("text help: exit %d\n%s", res.code, res.out)
	}
	bad := run(t, nil, false, "help", "agents", "draft", "frob")
	if bad.code != 2 || !strings.Contains(bad.errOut, "caitlyn commands") {
		t.Errorf("unknown command: exit %d %s", bad.code, bad.errOut)
	}
	if r := run(t, nil, false, "help", "agents", "draft", "save", "--format", "xml"); r.code != 2 {
		t.Errorf("--format xml: exit %d", r.code)
	}
	if r := run(t, nil, false, "help", "me", "--write"); r.code != 2 {
		t.Errorf("--write outside help agents: exit %d", r.code)
	}
}

func TestHelpExitCodes(t *testing.T) {
	res := run(t, nil, false, "help", "exit-codes")
	if res.code != 0 || !strings.Contains(res.out, "130") || !strings.Contains(res.out, "Rate limited after retries") {
		t.Errorf("exit %d\n%s", res.code, res.out)
	}
	res = run(t, nil, false, "help", "exit-codes", "--format", "json")
	var v struct {
		ExitCodes []map[string]any `json:"exitCodes"`
	}
	decode(t, res.out, &v)
	if len(v.ExitCodes) != 13 {
		t.Errorf("%d exit codes", len(v.ExitCodes))
	}
}

func TestHelpAgentsSnippet(t *testing.T) {
	res := run(t, []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}, false, "help", "agents", "--format", "markdown")
	if res.code != 0 {
		t.Fatalf("exit %d: %s", res.code, res.errOut)
	}
	if res.out != describe.AgentsSnippet("acme.caitlyn.ai") || !strings.Contains(res.out, "(workspace: acme.caitlyn.ai)") {
		t.Errorf("snippet:\n%s", res.out)
	}
	anon := run(t, nil, false, "help", "agents", "--format", "markdown")
	if strings.Contains(anon.out, "workspace:") || !strings.HasPrefix(anon.out, "## Caitlyn CLI\n") {
		t.Errorf("no workspace:\n%s", anon.out)
	}
	// Every line of the design's snippet is there
	for _, s := range []string{"caitlyn commands --json", "hint.next", "https://build.caitlyn.ai/cli/exit-codes/", "agent scopes", "`agent_scopes`", "exits 5", "caitlyn agents versions publish", "--dry-run", "--timeout", "caitlyn mcp add <client>", "https://build.caitlyn.ai/llms.txt"} {
		if !strings.Contains(anon.out, s) {
			t.Errorf("snippet lacks %q", s)
		}
	}
	// No second sign-in for protection agent scopes already give
	if strings.Contains(anon.out, "--profile readonly") {
		t.Errorf("the snippet still sends agents to a read-only profile:\n%s", anon.out)
	}
}

func TestHelpAgentsWriteStampsAndShowsTheDiff(t *testing.T) {
	work := t.TempDir()
	env := []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}
	// --dry-run shows the change and writes nothing
	dry := runIn(t, work, env, "help", "agents", "--write", "--dry-run")
	var v struct {
		Written []string `json:"written"`
		DryRun  bool     `json:"dryRun"`
		Changes []struct {
			File, Action, Diff string
			Added              int
		} `json:"changes"`
	}
	decode(t, dry.out, &v)
	if dry.code != 0 || !v.DryRun || len(v.Written) != 0 || len(v.Changes) != 1 || v.Changes[0].Action != "create" {
		t.Fatalf("exit %d: %s%s", dry.code, dry.out, dry.errOut)
	}
	if !strings.Contains(v.Changes[0].Diff, "--- /dev/null\n+++ b/AGENTS.md\n") || !strings.Contains(v.Changes[0].Diff, "+## Caitlyn CLI\n+<!-- caitlyn ai setup · caitlyn ") {
		t.Errorf("diff:\n%s", v.Changes[0].Diff)
	}
	if _, err := os.Stat(filepath.Join(work, "AGENTS.md")); !os.IsNotExist(err) {
		t.Fatal("--dry-run wrote AGENTS.md")
	}
	// As text: the diff, then what was written; the section carries the stamp under its heading
	res := runIn(t, work, env, "help", "agents", "--write", "--output", "text")
	if res.code != 0 || !strings.Contains(res.out, "+## Caitlyn CLI") || !strings.Contains(res.out, "Wrote "+filepath.Join(work, "AGENTS.md")) {
		t.Fatalf("exit %d: %s%s", res.code, res.out, res.errOut)
	}
	b, _ := os.ReadFile(filepath.Join(work, "AGENTS.md"))
	sec, ok := describe.FindSection(string(b))
	if !ok || !sec.Stamped || sec.Stamp.Workspace != "acme.caitlyn.ai" || sec.Stamp.Version == "" {
		t.Errorf("stamp: %+v\n%s", sec, b)
	}
	again := runIn(t, work, env, "help", "agents", "--write", "--output", "text")
	if !strings.Contains(again.out, "is up to date. Nothing changed.") {
		t.Errorf("second write: %s", again.out)
	}
	// --jq works on what it prints
	jq := runIn(t, t.TempDir(), env, "help", "agents", "--write", "--jq", ".written | length")
	if strings.TrimSpace(jq.out) != "1" {
		t.Errorf("--jq: %q", jq.out)
	}
	// Writing makes the run a write: the tree says so on the flag
	tr, _, _ := tree(t)
	h := tr.Find([]string{"help"})
	if h == nil {
		t.Fatal("help is not in the tree")
	}
	for _, fl := range h.Flags {
		if fl.Name == "write" && fl.Impact != "write" {
			t.Errorf("help --write impact %q", fl.Impact)
		}
	}
}

func TestHelpAgentsSkillDryRun(t *testing.T) {
	work := t.TempDir()
	res := runIn(t, work, nil, "help", "agents", "--format", "skill", "--write", "--dry-run", "--output", "text")
	if res.code != 0 || !strings.Contains(res.out, "+++ b/.claude/skills/caitlyn/SKILL.md") || !strings.Contains(res.out, "+++ b/.claude/skills/caitlyn/references/commands.md") || !strings.Contains(res.out, "Dry run: nothing was written.") {
		t.Fatalf("exit %d: %s%s", res.code, res.out, res.errOut)
	}
	if _, err := os.Stat(filepath.Join(work, ".claude")); !os.IsNotExist(err) {
		t.Fatal("--dry-run wrote the skill")
	}
}

func TestStamps(t *testing.T) {
	s := describe.NewStamp("0.12.4", "acme.caitlyn.ai")
	if s.Comment() != "<!-- caitlyn ai setup · caitlyn 0.12.4 · acme.caitlyn.ai -->" {
		t.Errorf("comment %q", s.Comment())
	}
	for _, in := range []string{s.Comment(), s.Text(), `"` + s.Text() + `"`} {
		if got, ok := describe.ParseStamp(in); !ok || got != s {
			t.Errorf("ParseStamp(%q) = %+v %v", in, got, ok)
		}
	}
	if got, ok := describe.ParseStamp("<!-- caitlyn ai setup · caitlyn 0.12.4 -->"); !ok || got.Workspace != "" {
		t.Errorf("no workspace: %+v %v", got, ok)
	}
	for _, in := range []string{"<!-- something else -->", "caitlyn ai setup", ""} {
		if _, ok := describe.ParseStamp(in); ok {
			t.Errorf("ParseStamp(%q) took it", in)
		}
	}
	if describe.NewStamp("", "").Version != "dev" {
		t.Error("a development build's stamp")
	}
}

func TestSkillStampAndHash(t *testing.T) {
	files := describe.StampSkill([]describe.SkillFile{
		{Path: "SKILL.md", Text: "---\nname: caitlyn\ndescription: x\n---\n\n# Body\n"},
		{Path: "references/commands.md", Text: "# commands\n"},
	}, describe.NewStamp("0.12.4", "acme.caitlyn.ai"))
	m, ok := describe.ReadSkillMark(files[0].Text, files[1].Text)
	if !ok || m.Edited || m.Stamp.Version != "0.12.4" || !strings.HasPrefix(m.Hash, "sha256:") {
		t.Fatalf("%+v %v\n%s", m, ok, files[0].Text)
	}
	if m, _ := describe.ReadSkillMark(files[0].Text+"Mine.\n", files[1].Text); !m.Edited {
		t.Error("an edited SKILL.md isn't seen")
	}
	if m, _ := describe.ReadSkillMark(files[0].Text, "# changed\n"); !m.Edited {
		t.Error("an edited commands.md isn't seen")
	}
	if _, ok := describe.ReadSkillMark("---\nname: caitlyn\n---\n", ""); ok {
		t.Error("an unstamped skill has a mark")
	}
}

func TestRemoveLinesRestores(t *testing.T) {
	sec := describe.StampedSnippet(describe.NewStamp("0.12.4", ""))
	cases := []struct{ before string }{
		{""},
		{"# A\n"},
		{"# A\n\nSome text.\n"},
	}
	for _, c := range cases {
		doc := describe.ReplaceSection(c.before, sec)
		s, ok := describe.FindSection(doc)
		if !ok || !s.Stamped {
			t.Fatalf("no stamped section in %q", doc)
		}
		if got := describe.RemoveLines(doc, s.Start, s.End); got != c.before {
			t.Errorf("RemoveLines(%q) = %q", doc, got)
		}
	}
	// In the middle of other content
	doc := "# P\n\nIntro.\n\n" + sec + "\n## Testing\n\nRun.\n"
	s, _ := describe.FindSection(doc)
	if got := describe.RemoveLines(doc, s.Start, s.End); got != "# P\n\nIntro.\n\n## Testing\n\nRun.\n" {
		t.Errorf("middle: %q", got)
	}
}

func TestHelpAgentsWriteReplacesItsOwnSection(t *testing.T) {
	work := t.TempDir()
	agents := filepath.Join(work, "AGENTS.md")
	before := "# Project\n\nIntro.\n\n## Caitlyn CLI\n\nOld text.\n\n## Testing\n\nRun make test.\n"
	if err := os.WriteFile(agents, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	res := runIn(t, work, []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}, "help", "agents", "--write")
	if res.code != 0 {
		t.Fatalf("exit %d: %s", res.code, res.errOut)
	}
	got, _ := os.ReadFile(agents)
	s := string(got)
	if strings.Contains(s, "Old text.") || !strings.Contains(s, "## Testing\n\nRun make test.") || !strings.HasPrefix(s, "# Project\n\nIntro.\n\n## Caitlyn CLI\n") || strings.Count(s, "## Caitlyn CLI") != 1 {
		t.Errorf("AGENTS.md:\n%s", s)
	}
	// A second write changes nothing
	runIn(t, work, []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}, "help", "agents", "--write")
	again, _ := os.ReadFile(agents)
	if string(again) != s {
		t.Errorf("not idempotent:\n%s", again)
	}
	// --path writes CLAUDE.md instead, appending to what is there
	claude := filepath.Join(work, "CLAUDE.md")
	_ = os.WriteFile(claude, []byte("# Notes\n"), 0o644)
	runIn(t, work, nil, "help", "agents", "--write", "--path", "CLAUDE.md")
	c, _ := os.ReadFile(claude)
	if !strings.HasPrefix(string(c), "# Notes\n\n## Caitlyn CLI\n") {
		t.Errorf("CLAUDE.md:\n%s", c)
	}
}

func TestReplaceSection(t *testing.T) {
	sec := "## Caitlyn CLI\n\nNew.\n"
	cases := []struct{ doc, want string }{
		{"", sec},
		{"# A\n", "# A\n\n" + sec},
		{"## Caitlyn CLI\n\nOld.\n", sec},
		{"## Caitlyn CLI\n\nOld.\n\n```md\n## not a heading\n```\n\n## Next\n\nKeep.\n", sec + "\n## Next\n\nKeep.\n"},
	}
	for _, c := range cases {
		if got := describe.ReplaceSection(c.doc, sec); got != c.want {
			t.Errorf("ReplaceSection(%q) = %q, want %q", c.doc, got, c.want)
		}
	}
}

func TestHelpAgentsSkill(t *testing.T) {
	res := run(t, nil, false, "help", "agents", "--format", "skill")
	if res.code != 0 || !strings.Contains(res.out, "<!-- SKILL.md -->\n---\nname: caitlyn\ndescription: ") || !strings.Contains(res.out, "<!-- references/commands.md -->") {
		t.Fatalf("exit %d\n%s", res.code, res.out)
	}
	work := t.TempDir()
	w := runIn(t, work, []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}, "help", "agents", "--format", "skill", "--write")
	if w.code != 0 {
		t.Fatalf("exit %d: %s", w.code, w.errOut)
	}
	skill, err := os.ReadFile(filepath.Join(work, ".claude", "skills", "caitlyn", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(skill)
	if !strings.HasPrefix(s, "---\nname: caitlyn\ndescription: "+describe.SkillDescription+"\nmetadata:\n  caitlyn-ai-setup: \"caitlyn ai setup · caitlyn ") || !strings.Contains(s, "acme.caitlyn.ai") {
		t.Errorf("SKILL.md:\n%s", s)
	}
	refs, _ := os.ReadFile(filepath.Join(work, ".claude", "skills", "caitlyn", "references", "commands.md"))
	if m, ok := describe.ReadSkillMark(s, string(refs)); !ok || m.Edited || m.Stamp.Workspace != "acme.caitlyn.ai" {
		t.Errorf("the skill's mark: %+v %v", m, ok)
	}
	if !strings.Contains(s, "`caitlyn agents versions publish` (user-facing)") || !strings.Contains(s, "`caitlyn agents delete` (destructive)") {
		t.Error("SKILL.md does not name the commands to ask about first")
	}
	ref, _ := os.ReadFile(filepath.Join(work, ".claude", "skills", "caitlyn", "references", "commands.md"))
	if !strings.Contains(string(ref), "| `caitlyn agents draft save <agent> [flags]` | write |") {
		t.Errorf("references/commands.md lacks agents draft save:\n%.400s", ref)
	}
}

func TestDocsPrintsTheAddressWithoutABrowser(t *testing.T) {
	cases := map[string]string{
		"":                  "https://build.caitlyn.ai/cli/\n",
		"agents draft save": "https://build.caitlyn.ai/cli/reference/agents/draft/#save\n",
		"agents draft":      "https://build.caitlyn.ai/cli/reference/agents/draft/\n",
		"kb documents":      "https://build.caitlyn.ai/cli/reference/knowledge-bases/documents/\n",
		"me":                "https://build.caitlyn.ai/cli/reference/me/\n",
		"mcp add":           "https://build.caitlyn.ai/cli/reference/mcp/#add",
	}
	for words, want := range cases {
		res := run(t, nil, false, append([]string{"docs"}, strings.Fields(words)...)...)
		if res.code != 0 || strings.TrimSpace(res.out) != strings.TrimSpace(want) {
			t.Errorf("caitlyn docs %s: exit %d %q, want %q", words, res.code, res.out, want)
		}
	}
	if res := run(t, nil, false, "docs", "agents", "frob"); res.code != 2 {
		t.Errorf("unknown command: exit %d", res.code)
	}
}

func TestDocsOpensABrowserOnATerminal(t *testing.T) {
	var got []string
	old := describe.StartBrowser
	describe.StartBrowser = func(name string, args ...string) error {
		got = append([]string{name}, args...)
		return nil
	}
	defer func() { describe.StartBrowser = old }()
	res := run(t, []string{"BROWSER=my-browser --new-tab"}, true, "docs", "kb", "documents", "get")
	if res.code != 0 || strings.Join(got, " ") != "my-browser --new-tab https://build.caitlyn.ai/cli/reference/knowledge-bases/documents/#get" {
		t.Errorf("exit %d, started %v, err %s", res.code, got, res.errOut)
	}
	if res.out != "" || !strings.Contains(res.errOut, "Opening") {
		t.Errorf("stdout %q stderr %q", res.out, res.errOut)
	}
	// In agent mode it prints, even on a terminal
	got = nil
	res = run(t, []string{"BROWSER=x", "CAITLYN_AGENT=1"}, true, "docs", "me")
	if got != nil || strings.TrimSpace(res.out) != "https://build.caitlyn.ai/cli/reference/me/" {
		t.Errorf("agent mode opened %v / printed %q", got, res.out)
	}
	// A browser that fails to start: the address is printed
	describe.StartBrowser = func(string, ...string) error { return os.ErrNotExist }
	res = run(t, []string{"BROWSER=x"}, true, "docs", "--print")
	if strings.TrimSpace(res.out) != "https://build.caitlyn.ai/cli/" {
		t.Errorf("--print: %q", res.out)
	}
	res = run(t, []string{"BROWSER=x"}, true, "docs")
	if strings.TrimSpace(res.out) != "https://build.caitlyn.ai/cli/" {
		t.Errorf("failed browser: %q", res.out)
	}
}

func TestMCPAddPrints(t *testing.T) {
	env := []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}
	res := run(t, env, true, "mcp", "add", "claude-code")
	if res.code != 0 || !strings.Contains(res.out, "claude mcp add --transport http caitlyn https://acme.caitlyn.ai/api/mcp") || !strings.Contains(res.out, ".mcp.json") {
		t.Errorf("exit %d\n%s%s", res.code, res.out, res.errOut)
	}
	for client, want := range map[string]string{
		"cursor": `{"mcpServers":{"caitlyn":{"url":"https://acme.caitlyn.ai/api/mcp"}}}`,
		"vscode": `{"servers":{"caitlyn":{"type":"http","url":"https://acme.caitlyn.ai/api/mcp"}}}`,
		"claude": `{"mcpServers":{"caitlyn":{"type":"http","url":"https://acme.caitlyn.ai/api/mcp"}}}`,
	} {
		r := run(t, env, false, "mcp", "add", client)
		var v describe.MCPAdded
		decode(t, r.out, &v)
		got, _ := json.Marshal(v.Config)
		if string(got) != want || v.Written {
			t.Errorf("%s: %s written=%v", client, got, v.Written)
		}
	}
	if r := run(t, env, false, "mcp", "add", "emacs"); r.code != 2 {
		t.Errorf("unknown client: exit %d", r.code)
	}
	if r := run(t, nil, false, "mcp", "add", "cursor"); r.code != 4 || !strings.Contains(r.errOut, "auth login") {
		t.Errorf("no workspace: exit %d %s", r.code, r.errOut)
	}
}

func TestMCPAddWriteKeepsOtherServers(t *testing.T) {
	work := t.TempDir()
	env := []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}
	file := filepath.Join(work, ".vscode", "mcp.json")
	_ = os.MkdirAll(filepath.Dir(file), 0o755)
	_ = os.WriteFile(file, []byte(`{"servers":{"other":{"type":"stdio","command":"x"}},"inputs":[]}`), 0o644)
	res := runIn(t, work, env, "mcp", "add", "vscode", "--write")
	var added describe.MCPAdded
	decode(t, res.out, &added)
	if res.code != 0 || !added.Written || !added.Changed || added.File != file {
		t.Fatalf("exit %d\n%s%s", res.code, res.out, res.errOut)
	}
	var doc map[string]any
	b, _ := os.ReadFile(file)
	decode(t, string(b), &doc)
	servers := doc["servers"].(map[string]any)
	if servers["other"] == nil || servers["caitlyn"] == nil || doc["inputs"] == nil {
		t.Errorf("file: %s", b)
	}
	again := runIn(t, work, env, "mcp", "add", "vscode", "--write")
	decode(t, again.out, &added)
	if added.Changed {
		t.Errorf("second write changed the file: %s", again.out)
	}
	// On a terminal, people are told what happened
	tty := run(t, env, true, "mcp", "add", "cursor")
	if !strings.Contains(tty.out, "Add this to .cursor/mcp.json") || !strings.Contains(tty.out, "caitlyn mcp add cursor --write") {
		t.Errorf("text: %s", tty.out)
	}
	// A file with comments isn't JSON: refused, untouched
	cursor := filepath.Join(work, ".cursor", "mcp.json")
	_ = os.MkdirAll(filepath.Dir(cursor), 0o755)
	_ = os.WriteFile(cursor, []byte("// mine\n{}"), 0o644)
	r := runIn(t, work, env, "mcp", "add", "cursor", "--write")
	kept, _ := os.ReadFile(cursor)
	if r.code != 2 || string(kept) != "// mine\n{}" {
		t.Errorf("exit %d, file %q", r.code, kept)
	}
	// Claude Code's project file
	runIn(t, work, env, "mcp", "add", "claude-code", "--write")
	b, _ = os.ReadFile(filepath.Join(work, ".mcp.json"))
	if !strings.Contains(string(b), `"type": "http"`) {
		t.Errorf(".mcp.json: %s", b)
	}
}

func TestMCPAddRefusesAnEntryWithCredentials(t *testing.T) {
	work := t.TempDir()
	file := filepath.Join(work, ".mcp.json")
	before := `{"mcpServers":{"caitlyn":{"type":"http","url":"https://acme.caitlyn.ai/api/mcp","headers":{"Authorization":"Bearer x"}}}}`
	_ = os.WriteFile(file, []byte(before), 0o644)
	r := runIn(t, work, []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}, "mcp", "add", "claude-code", "--write")
	kept, _ := os.ReadFile(file)
	if r.code != 2 || !strings.Contains(r.errOut, "MCP_ENTRY_HAS_CREDENTIALS") || string(kept) != before {
		t.Errorf("exit %d %s\nfile %s", r.code, r.errOut, kept)
	}
}

func TestInputSchemaOfANestedInput(t *testing.T) {
	m := spec.MustLoad()
	s := describe.InputSchema(m, m.Op("UpdateDraftVersion"))
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	defs, _ := s["$defs"].(map[string]any)
	if len(defs) == 0 {
		t.Fatal("a nested input has no $defs")
	}
	// Every $ref names a definition the document has
	for _, ref := range refs(string(b)) {
		if _, ok := defs[strings.TrimPrefix(ref, "#/$defs/")]; !ok {
			t.Errorf("$ref %s names no definition", ref)
		}
	}
	props := s["properties"].(map[string]any)
	if loc := props["agentId"].(map[string]any)["x-caitlyn-location"]; loc != "path" {
		t.Errorf("agentId's location: %v", loc)
	}
}

func refs(s string) []string {
	var out []string
	for {
		i := strings.Index(s, `"$ref":"`)
		if i < 0 {
			return out
		}
		s = s[i+8:]
		out = append(out, s[:strings.Index(s, `"`)])
	}
}

func TestMarkdownCoversEveryFlagAndCode(t *testing.T) {
	tr, _, _ := tree(t)
	for _, c := range tr.Commands {
		md := describe.Markdown(c, tr, 2)
		for _, f := range c.Flags {
			if !f.Hidden && !strings.Contains(md, "`--"+f.Name+"`") {
				t.Errorf("%s: --%s is not in its Markdown", c.Name, f.Name)
			}
		}
		for _, e := range c.Errors {
			if !strings.Contains(md, "`"+e.Code+"`") {
				t.Errorf("%s: %s is not in its Markdown", c.Name, e.Code)
			}
		}
		for _, x := range c.ExitCodes {
			if c.Kind == "command" && !strings.Contains(md, "\n| "+itoa(x)+" |") {
				t.Errorf("%s: exit code %d is not in its Markdown", c.Name, x)
			}
		}
	}
}

// TestPagesStayWithinTheirBudget: an AI agent fetches one page per command group, so none is over about 4,000
// tokens; a group that would be has a page per command, and keeps a section per command for its address.
func TestPagesStayWithinTheirBudget(t *testing.T) {
	tr, _, _ := tree(t)
	pages := describe.Pages(tr)
	byPath := map[string]*describe.Page{}
	for _, p := range pages {
		byPath[strings.Join(p.Path, "/")] = p
		if len(p.Markdown) > describe.PageBudget {
			t.Errorf("%s is %d characters, over %d", p.Title, len(p.Markdown), describe.PageBudget)
		}
	}
	documented := map[string]bool{}
	for _, p := range pages {
		for _, c := range p.Commands {
			if documented[c] {
				t.Errorf("caitlyn %s is documented in full on two pages", c)
			}
			documented[c] = true
		}
	}
	for _, c := range tr.Commands {
		if c.Kind == "command" && !documented[c.Name] {
			t.Errorf("caitlyn %s is documented on no page", c.Name)
		}
		if c.Kind == "group" && byPath[strings.Join(c.Path, "/")] == nil {
			t.Errorf("the group caitlyn %s has no page", c.Name)
		}
		// Every command's address names a heading on its group's page
		if c.Kind == "command" && len(c.Path) > 1 {
			group := byPath[strings.Join(c.Path[:len(c.Path)-1], "/")]
			if group == nil || !strings.Contains("\n"+group.Markdown, "\n## "+c.Path[len(c.Path)-1]+"\n") {
				t.Errorf("%s names no section on its group's page", c.Docs)
			}
		}
	}
	if byPath["knowledge-bases/documents/list"] == nil {
		t.Error("the documents group is over budget, so list should have a page of its own")
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

var update = flag.Bool("update", false, "rewrite docs/cli/tree.json")

// TestDocsSnapshot keeps docs/cli/tree.json, which the docs build reads, equal to what this CLI describes: the whole
// tree with the hidden commands, each command's Markdown (its section of the docs), the reference's start page, and
// the AGENTS.md section. When a command, flag or the model changes, run
//
//	go test ./internal/commands/describe -run TestDocsSnapshot -update
//
// and commit the file with the change.
func TestDocsSnapshot(t *testing.T) {
	tr, _, _ := tree(t)
	snap := describe.Snapshot(tr)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(snap); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("..", "..", "..", "..", "docs", "cli", "tree.json")
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v: run go test ./internal/commands/describe -run TestDocsSnapshot -update", err)
	}
	if !bytes.Equal(got, buf.Bytes()) {
		t.Fatalf("docs/cli/tree.json is out of date: run go test ./internal/commands/describe -run TestDocsSnapshot -update, and commit it")
	}
}

// TestAIAgentsPageCarriesTheSnippet: the docs' AI agents page shows the AGENTS.md section exactly as
// `caitlyn help agents --format markdown` prints it.
func TestAIAgentsPageCarriesTheSnippet(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "cli", "ai-agents.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), "```markdown\n"+describe.AgentsSnippet("")+"```") {
		t.Error("docs/cli/ai-agents.md does not carry the AGENTS.md section as caitlyn help agents prints it")
	}
}

// A hand-written command's "operation" annotation is how the agent-scope and read-only checks know what it needs:
// every name it gives must be an operation in the manifest, with a permission (or the command only reads).
func TestHandWrittenOperationsExist(t *testing.T) {
	_, r, _ := tree(t)
	m := spec.MustLoad()
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		if ops := c.Annotations["operation"]; ops != "" && c.Annotations["generated"] == "" {
			for _, name := range strings.Split(ops, ",") {
				name = strings.TrimSpace(name)
				op := m.Op(name)
				switch {
				case op == nil:
					t.Errorf("%s names %s, which isn't in the manifest", c.CommandPath(), name)
				case op.Permission == nil && c.Annotations["impact"] != "read":
					t.Errorf("%s names %s, which has no permission, so its scopes can't be checked", c.CommandPath(), name)
				}
			}
		}
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(r)
}

func TestProseEscapesPlaceholders(t *testing.T) {
	for in, want := range map[string]string{
		"https://<workspace>/api/mcp":      `https://\<workspace>/api/mcp`,
		"`https://<workspace>/api/mcp`":    "`https://<workspace>/api/mcp`",
		"use <agent[@version]> or <a|b>":   `use \<agent[@version]> or \<a|b>`,
		"```sh\ncaitlyn chat <agent>\n```": "```sh\ncaitlyn chat <agent>\n```",
		"less than: a < b, and \\<kept>":   "less than: a < b, and \\<kept>",
	} {
		if got := describe.Prose(in); got != want {
			t.Errorf("Prose(%q) = %q, want %q", in, got, want)
		}
	}
}

// Every example a group or hand-written command shows (its Example text, from naming.yaml or the command) names a
// command that exists and flags it takes, and every naming.yaml groups and commands key names a command.
func TestHelpExamplesAreRealCommands(t *testing.T) {
	_, r, _ := tree(t)
	o := spec.MustOverlay()
	for _, set := range []map[string]*spec.GroupHelp{o.Groups, o.Commands} {
		for path := range set {
			if c, _, err := r.Find(strings.Fields(path)); err != nil || c == r || c.CommandPath() != "caitlyn "+path {
				t.Errorf("naming.yaml names %q, which is no command", path)
			}
		}
	}
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, line := range strings.Split(c.Example, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") || !strings.HasPrefix(line, "caitlyn ") {
				continue
			}
			// the command itself: before a redirection or a pipe
			for _, cut := range []string{" > ", " | ", " < "} {
				if i := strings.Index(line, cut); i > 0 {
					line = line[:i]
				}
			}
			args := shellwords.Split(strings.TrimPrefix(line, "caitlyn "))
			cmd, rest, err := r.Find(args)
			if err != nil || cmd == r {
				t.Errorf("%s: example %q names no command", c.CommandPath(), line)
				continue
			}
			if cmd.DisableFlagParsing {
				continue
			}
			cmd.InitDefaultHelpFlag()
			if err := cmd.ParseFlags(rest); err != nil {
				t.Errorf("%s: example %q: %v", c.CommandPath(), line, err)
			}
			cmd.Flags().VisitAll(func(fl *pflag.Flag) { _ = fl.Value.Set(fl.DefValue); fl.Changed = false })
		}
		for _, s := range c.Commands() {
			walk(s)
		}
	}
	walk(r)
}

func TestHandWrittenArgsKeepInnerBrackets(t *testing.T) {
	tr, _, _ := tree(t)
	d := tr.Find([]string{"chat"})
	if d == nil || len(d.Args) == 0 || d.Args[0].Name != "agent[@version]" {
		t.Fatalf("chat's first argument: %+v", d)
	}
}
