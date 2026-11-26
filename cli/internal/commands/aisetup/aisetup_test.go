package aisetup_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/aisetup"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/describe"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

var registerOnce sync.Once

func register() { registerOnce.Do(commands.Register) }

type result struct {
	code        int
	out, errOut string
}

// run runs the CLI in work (a project: it has .git), with home as the home folder. in is stdin; tty makes every
// stream a terminal.
func run(t *testing.T, work, home string, env []string, tty bool, in string, args ...string) result {
	t.Helper()
	register()
	io, out, errOut := iostreams.Test(in)
	io.Environ = append([]string{"CAITLYN_CONFIG_DIR=" + filepath.Join(home, ".caitlyn")}, env...)
	io.SetTTY(tty, tty, tty)
	code := root.Run(context.Background(), io, args, func(f *cmdutil.Factory) {
		f.Home, f.WorkDir = home, work
	})
	return result{code: code, out: out.String(), errOut: errOut.String()}
}

// project is a temporary repository with the given files (a name ending in / is a folder).
func project(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, text := range files {
		p := filepath.Join(dir, filepath.FromSlash(strings.TrimSuffix(name, "/")))
		if strings.HasSuffix(name, "/") {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func read(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
	if err != nil {
		return "<missing>"
	}
	return string(b)
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, filepath.FromSlash(name)))
	return err == nil
}

type plan struct {
	DryRun    bool   `json:"dryRun"`
	Written   bool   `json:"written"`
	Workspace string `json:"workspace"`
	Tools     []string
	With      []string
	Changes   []struct {
		Action, File, What, Diff, Summary string
		Tools                             []string
		Added, Removed                    int
		Edited                            bool
	}
	Skipped  []struct{ What, Tool, File, Why, Detail string }
	Detected []struct {
		Name    string
		Markers []string
		Hints   []string
		Running bool
	}
}

func decode(t *testing.T, s string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(s), v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, s)
	}
}

func (p plan) files() []string {
	var out []string
	for _, c := range p.Changes {
		out = append(out, c.Action+" "+c.File)
	}
	sort.Strings(out)
	return out
}

func (p plan) skipped(what, tool string) string {
	for _, s := range p.Skipped {
		if s.What == what && (tool == "" || s.Tool == tool) {
			return s.Why
		}
	}
	return ""
}

var ws = []string{"CAITLYN_WORKSPACE=acme.caitlyn.ai"}

func TestDetect(t *testing.T) {
	dir := project(t, map[string]string{"CLAUDE.md": "# Notes\n", ".cursor/": "", "GEMINI.md": "x"})
	home := t.TempDir()
	_ = os.Mkdir(filepath.Join(home, ".codex"), 0o755)
	bin := t.TempDir()
	_ = os.WriteFile(filepath.Join(bin, "code"), []byte("#!/bin/sh\n"), 0o755)
	got := map[string]aisetup.Detection{}
	for _, d := range aisetup.Detect(dir, aisetup.Env{Home: home, Getenv: func(k string) string {
		if k == "PATH" {
			return bin
		}
		return ""
	}, Agent: "gemini-cli"}) {
		got[d.Name] = d
	}
	if d := got["claude-code"]; !d.Selected() || strings.Join(d.Markers, ",") != "CLAUDE.md" {
		t.Errorf("claude-code: %+v", d)
	}
	if d := got["cursor"]; !d.Selected() || strings.Join(d.Markers, ",") != ".cursor/" {
		t.Errorf("cursor: %+v", d)
	}
	// User-level hints only add a tool, unselected
	if d := got["codex"]; d.Selected() || strings.Join(d.Hints, ",") != "~/.codex/" {
		t.Errorf("codex: %+v", d)
	}
	if d := got["copilot"]; d.Selected() || strings.Join(d.Hints, ",") != "code on PATH" {
		t.Errorf("copilot: %+v", d)
	}
	if d := got["gemini-cli"]; !d.Selected() || !d.Running {
		t.Errorf("gemini-cli: %+v", d)
	}
	// A folder isn't a file marker, nor a file a folder marker
	other := project(t, map[string]string{".cursor": "not a folder", "CLAUDE.md/": ""})
	if d := aisetup.Detect(other, aisetup.Env{}); len(d) != 0 {
		t.Errorf("wrong kinds detected: %+v", d)
	}
}

func TestProjectRoot(t *testing.T) {
	dir := project(t, nil)
	sub := filepath.Join(dir, "a", "b")
	_ = os.MkdirAll(sub, 0o755)
	if root, ok := aisetup.ProjectRoot(sub, filepath.Dir(dir)); !ok || root != dir {
		t.Errorf("ProjectRoot = %s %v", root, ok)
	}
	home := t.TempDir()
	loose := filepath.Join(home, "notes")
	_ = os.Mkdir(loose, 0o755)
	if _, ok := aisetup.ProjectRoot(loose, home); ok {
		t.Error("a folder in no repository is a project")
	}
}

// The plan for each combination of tools that matters.
func TestPlans(t *testing.T) {
	cases := []struct {
		name    string
		files   map[string]string
		args    []string
		env     []string
		want    []string
		skipped map[string]string // what/tool → why
	}{
		{name: "nothing found: AGENTS.md, which most tools read", want: []string{"create AGENTS.md"}},
		{name: "Claude Code alone: its own CLAUDE.md, the skill and .mcp.json", files: map[string]string{".claude/": ""},
			want: []string{"create .claude/skills/caitlyn/SKILL.md", "create .claude/skills/caitlyn/references/commands.md", "create .mcp.json", "create CLAUDE.md"}},
		{name: "Claude Code and Cursor: AGENTS.md, imported from CLAUDE.md", files: map[string]string{"CLAUDE.md": "# Notes\n", ".cursor/": ""},
			want: []string{"change CLAUDE.md", "create .claude/skills/caitlyn/SKILL.md", "create .claude/skills/caitlyn/references/commands.md", "create .cursor/mcp.json", "create .mcp.json", "create AGENTS.md"}},
		{name: "Codex: AGENTS.md; its MCP servers aren't in the project", files: map[string]string{".codex/": ""}, args: []string{"--with", "instructions,mcp"},
			want: []string{"create AGENTS.md"}, skipped: map[string]string{"mcp/codex": "NOT_SUPPORTED"}},
		{name: "Copilot and Gemini CLI: their own files", files: map[string]string{".vscode/mcp.json": `{"servers":{}}`, "GEMINI.md": "# G\n"},
			want: []string{"change .vscode/mcp.json", "change GEMINI.md", "create .github/copilot-instructions.md"}, skipped: map[string]string{"mcp/gemini-cli": "NOT_SUPPORTED"}},
		{name: "--no-workspace: no MCP server, which names it", files: map[string]string{".claude/": ""}, args: []string{"--no-workspace"},
			want:    []string{"create .claude/skills/caitlyn/SKILL.md", "create .claude/skills/caitlyn/references/commands.md", "create CLAUDE.md"},
			skipped: map[string]string{"mcp/claude-code": "NO_WORKSPACE"}},
		{name: "not signed in: no MCP server", files: map[string]string{".cursor/": ""}, env: []string{},
			want: []string{"create AGENTS.md"}, skipped: map[string]string{"mcp/cursor": "NO_WORKSPACE"}},
		{name: "--tools and --with choose", args: []string{"--tools", "cursor,claude", "--with", "instructions,defaults"},
			want: []string{"create .caitlyn.toml", "create AGENTS.md", "create CLAUDE.md"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := project(t, c.files)
			env := ws
			if c.env != nil {
				env = c.env
			}
			args := append([]string{"ai", "setup", "--dry-run", "--output", "json"}, c.args...)
			r := run(t, dir, t.TempDir(), env, false, "", args...)
			if r.code != 0 {
				t.Fatalf("exit %d: %s%s", r.code, r.out, r.errOut)
			}
			var p plan
			decode(t, r.out, &p)
			if got := strings.Join(p.files(), "\n"); got != strings.Join(c.want, "\n") {
				t.Errorf("files:\n%s\nwant:\n%s", got, strings.Join(c.want, "\n"))
			}
			for k, why := range c.skipped {
				what, tool, _ := strings.Cut(k, "/")
				if got := p.skipped(what, tool); got != why {
					t.Errorf("%s skipped %q, want %q (%+v)", k, got, why, p.Skipped)
				}
			}
			if !p.DryRun || p.Written {
				t.Errorf("dryRun %v written %v", p.DryRun, p.Written)
			}
			for _, ch := range p.Changes {
				if ch.Diff == "" {
					t.Errorf("%s has no diff", ch.File)
				}
				if ch.Action == "create" && exists(dir, ch.File) {
					t.Errorf("--dry-run wrote %s", ch.File)
				}
			}
		})
	}
}

func TestSetupWritesWhatItPlannedAndIsIdempotent(t *testing.T) {
	mcp := "{\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\"\n    }\n  }\n}\n"
	dir := project(t, map[string]string{"CLAUDE.md": "# Notes\n\nKeep me.\n", ".cursor/": "", ".mcp.json": mcp})
	home := t.TempDir()
	r := run(t, dir, home, ws, false, "", "ai", "setup", "--output", "json")
	var p plan
	decode(t, r.out, &p)
	if r.code != 0 || !p.Written || len(p.Changes) != 6 {
		t.Fatalf("exit %d: %s%s", r.code, r.out, r.errOut)
	}
	claude := read(t, dir, "CLAUDE.md")
	if !strings.HasPrefix(claude, "# Notes\n\nKeep me.\n\n<!-- caitlyn ai setup") || !strings.HasSuffix(claude, "\n@AGENTS.md\n") {
		t.Errorf("CLAUDE.md:\n%s", claude)
	}
	agents := read(t, dir, "AGENTS.md")
	if sec, ok := describe.FindSection(agents); !ok || !sec.Stamped || sec.Stamp.Workspace != "acme.caitlyn.ai" || !strings.Contains(agents, "(workspace: acme.caitlyn.ai)") {
		t.Errorf("AGENTS.md:\n%s", agents)
	}
	var doc map[string]map[string]map[string]any
	decode(t, read(t, dir, ".mcp.json"), &doc)
	if doc["mcpServers"]["other"] == nil || doc["mcpServers"]["caitlyn"]["url"] != "https://acme.caitlyn.ai/api/mcp" {
		t.Errorf(".mcp.json: %v", doc)
	}
	// No credentials anywhere
	for _, f := range []string{".mcp.json", ".cursor/mcp.json"} {
		if s := read(t, dir, f); strings.Contains(s, "headers") || strings.Contains(s, "token") || strings.Contains(s, "env") {
			t.Errorf("%s: %s", f, s)
		}
	}
	// A second run changes nothing, and says so
	again := run(t, dir, home, ws, false, "", "ai", "setup", "--output", "text")
	if again.code != 0 || !strings.Contains(again.out, "Everything is already set up. Nothing changed.") {
		t.Errorf("exit %d: %s%s", again.code, again.out, again.errOut)
	}
	// Status reports it all, up to date
	st := run(t, dir, home, ws, false, "", "ai", "status", "--output", "json")
	var sv struct {
		UpToDate bool
		Items    []struct{ File, What, State string }
	}
	decode(t, st.out, &sv)
	if !sv.UpToDate || len(sv.Items) != 5 {
		t.Errorf("status: %s", st.out)
	}
}

func TestRemoveRestoresFilesExactly(t *testing.T) {
	mcp := "{\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\"\n    }\n  }\n}\n"
	before := map[string]string{
		"CLAUDE.md": "# Notes\n\nKeep me.\n",
		"AGENTS.md": "# Agents\n\n## Testing\n\nRun make test.\n",
		".mcp.json": mcp,
		".cursor/":  "",
		"GEMINI.md": "# Gemini\n",
		"README.md": "untouched\n",
		".claude/x": "mine\n",
	}
	dir := project(t, before)
	home := t.TempDir()
	if r := run(t, dir, home, ws, false, "", "ai", "setup", "--tools", "claude-code,cursor,codex,gemini-cli,copilot", "--yes"); r.code != 0 {
		t.Fatalf("setup: exit %d: %s%s", r.code, r.out, r.errOut)
	}
	if !exists(dir, ".github/copilot-instructions.md") || !exists(dir, ".claude/skills/caitlyn/SKILL.md") {
		t.Fatal("setup didn't write everything")
	}
	// A dry run of remove changes nothing
	dry := run(t, dir, home, ws, false, "", "ai", "remove", "--dry-run", "--output", "json")
	var p plan
	decode(t, dry.out, &p)
	if dry.code != 0 || !p.DryRun || !exists(dir, ".github/copilot-instructions.md") {
		t.Fatalf("dry run: exit %d %s%s", dry.code, dry.out, dry.errOut)
	}
	r := run(t, dir, home, ws, false, "", "ai", "remove", "--output", "text")
	if r.code != 0 {
		t.Fatalf("remove: exit %d: %s%s", r.code, r.out, r.errOut)
	}
	for name, text := range before {
		if strings.HasSuffix(name, "/") {
			continue
		}
		if got := read(t, dir, name); got != text {
			t.Errorf("%s:\n%q\nwant\n%q", name, got, text)
		}
	}
	for _, gone := range []string{".github/copilot-instructions.md", ".claude/skills", ".cursor/mcp.json", ".vscode/mcp.json"} {
		if exists(dir, gone) {
			t.Errorf("%s is still there", gone)
		}
	}
	// Nothing left to remove
	again := run(t, dir, home, ws, false, "", "ai", "remove", "--output", "text")
	if !strings.Contains(again.out, "Nothing here was made by caitlyn ai setup. Nothing changed.") {
		t.Errorf("second remove: %s", again.out)
	}
}

func TestRemoveOnlyTheNamedTools(t *testing.T) {
	dir := project(t, map[string]string{".cursor/": "", ".claude/": ""})
	home := t.TempDir()
	if r := run(t, dir, home, ws, false, "", "ai", "setup", "--yes"); r.code != 0 {
		t.Fatalf("setup: exit %d %s", r.code, r.errOut)
	}
	// Cursor alone: its MCP file goes; AGENTS.md stays, because Codex reads it too
	r := run(t, dir, home, ws, false, "", "ai", "remove", "--tools", "cursor", "--yes", "--output", "json")
	var p plan
	decode(t, r.out, &p)
	if r.code != 0 || strings.Join(p.files(), ",") != "delete .cursor/mcp.json" || p.skipped(aisetup.WithInstructions, "") != aisetup.SkipShared {
		t.Errorf("exit %d: %v %+v %s", r.code, p.files(), p.Skipped, r.errOut)
	}
	if !exists(dir, ".mcp.json") || !strings.Contains(read(t, dir, "AGENTS.md"), "## Caitlyn CLI") {
		t.Error("removed more than Cursor's")
	}
}

func TestRemoveAsksAboutAnEditedSkill(t *testing.T) {
	dir := project(t, map[string]string{".claude/": ""})
	home := t.TempDir()
	if r := run(t, dir, home, ws, false, "", "ai", "setup", "--yes"); r.code != 0 {
		t.Fatalf("setup: exit %d %s", r.code, r.errOut)
	}
	skill := filepath.Join(dir, ".claude", "skills", "caitlyn", "SKILL.md")
	b, _ := os.ReadFile(skill)
	_ = os.WriteFile(skill, append(b, []byte("\nOur own note.\n")...), 0o644)
	// With nobody to ask, it is kept
	r := run(t, dir, home, ws, false, "", "ai", "remove", "--output", "json")
	var p plan
	decode(t, r.out, &p)
	if r.code != 0 || !exists(dir, ".claude/skills/caitlyn/SKILL.md") || p.skipped(aisetup.WithSkill, "") != aisetup.SkipEdited {
		t.Errorf("exit %d %s%s", r.code, r.out, r.errOut)
	}
	// Status says it was edited
	st := run(t, dir, home, ws, false, "", "ai", "status", "--output", "text")
	if !strings.Contains(st.out, "edited") {
		t.Errorf("status: %s", st.out)
	}
	// At a terminal it asks; no keeps it
	r = run(t, dir, home, ws, true, "n\n", "ai", "remove", "--output", "text")
	if !exists(dir, ".claude/skills/caitlyn/SKILL.md") || !strings.Contains(r.errOut, "was changed by hand since caitlyn ai setup wrote it. Remove it anyway?") {
		t.Errorf("exit %d %s%s", r.code, r.out, r.errOut)
	}
	// yes removes it (then the plan's question: 1, yes)
	r = run(t, dir, home, ws, true, "y\n1\n", "ai", "remove", "--output", "text")
	if r.code != 0 || exists(dir, ".claude/skills") {
		t.Errorf("exit %d %s%s", r.code, r.out, r.errOut)
	}
}

func TestCheck(t *testing.T) {
	dir := project(t, map[string]string{".codex/": ""})
	home := t.TempDir()
	// Nothing set up: nothing out of date
	if r := run(t, dir, home, ws, false, "", "ai", "setup", "--check", "--output", "text"); r.code != 0 {
		t.Errorf("nothing set up: exit %d %s", r.code, r.errOut)
	}
	if r := run(t, dir, home, ws, false, "", "ai", "setup", "--yes"); r.code != 0 {
		t.Fatalf("setup: exit %d %s", r.code, r.errOut)
	}
	if r := run(t, dir, home, ws, false, "", "ai", "setup", "--check", "--output", "text"); r.code != 0 || !strings.Contains(r.out, "AGENTS.md  up to date") {
		t.Errorf("up to date: exit %d %s%s", r.code, r.out, r.errOut)
	}
	// In CI, without a sign-in, the file's own workspace is kept
	if r := run(t, dir, home, []string{"CAITLYN_CI=gitlab"}, false, "", "ai", "setup", "--check"); r.code != 0 {
		t.Errorf("CI without a workspace: exit %d %s%s", r.code, r.out, r.errOut)
	}
	// Another workspace
	other := run(t, dir, home, []string{"CAITLYN_WORKSPACE=other.caitlyn.ai"}, false, "", "ai", "setup", "--check", "--output", "text")
	if other.code != 3 || !strings.Contains(other.out, "made for acme.caitlyn.ai; the profile's workspace is other.caitlyn.ai") {
		t.Errorf("another workspace: exit %d %s%s", other.code, other.out, other.errOut)
	}
	// Made by an older CLI
	agents := read(t, dir, "AGENTS.md")
	v := spec.MustLoad().Version
	_ = os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(strings.Replace(agents, "caitlyn "+v, "caitlyn 0.0.1", 1)), 0o644)
	old := run(t, dir, home, ws, false, "", "ai", "setup", "--check")
	if old.code != 3 || !strings.Contains(old.errOut, `"code":"AI_SETUP_OUT_OF_DATE"`) || !strings.Contains(old.errOut, "caitlyn ai setup --update") {
		t.Errorf("older: exit %d %s%s", old.code, old.out, old.errOut)
	}
	var sv struct {
		UpToDate bool
		Items    []struct{ File, State, Reason string }
	}
	decode(t, old.out, &sv)
	if sv.UpToDate || len(sv.Items) != 1 || sv.Items[0].Reason != "made by caitlyn 0.0.1; this is "+v {
		t.Errorf("check JSON: %s", old.out)
	}
	// --update brings it up to date, and adds nothing new
	up := run(t, dir, home, ws, false, "", "ai", "setup", "--update", "--output", "json")
	var p plan
	decode(t, up.out, &p)
	if up.code != 0 || strings.Join(p.files(), ",") != "change AGENTS.md" {
		t.Errorf("update: exit %d %v %s", up.code, p.files(), up.errOut)
	}
	if r := run(t, dir, home, ws, false, "", "ai", "setup", "--check"); r.code != 0 {
		t.Errorf("after update: exit %d %s", r.code, r.errOut)
	}
	if r := run(t, dir, home, ws, false, "", "ai", "setup", "--update", "--tools", "codex"); r.code != 2 {
		t.Errorf("--update --tools: exit %d", r.code)
	}
}

func TestAgentModeShowsThePlanAndNeedsYes(t *testing.T) {
	dir := project(t, map[string]string{".claude/": ""})
	home := t.TempDir()
	env := append([]string{"CLAUDE_CODE_CHILD_SESSION=1"}, ws...)
	r := run(t, dir, home, env, true, "", "ai", "setup")
	if r.code != 3 || !strings.Contains(r.errOut, `"code":"CONFIRMATION_REQUIRED"`) || !strings.Contains(r.errOut, "caitlyn ai setup --tools claude-code --with instructions,skill,mcp --yes") {
		t.Fatalf("exit %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	var p plan
	decode(t, r.out, &p)
	if p.Written || len(p.Changes) != 4 || exists(dir, "CLAUDE.md") {
		t.Fatalf("wrote without --yes: %s", r.out)
	}
	if len(p.Detected) != 1 || !p.Detected[0].Running {
		t.Errorf("the running tool: %+v", p.Detected)
	}
	// --dry-run is the plan, exit 0
	if d := run(t, dir, home, env, true, "", "ai", "setup", "--dry-run"); d.code != 0 || !strings.Contains(d.out, `"dryRun": true`) {
		t.Errorf("dry run: exit %d %s%s", d.code, d.out, d.errOut)
	}
	// --yes writes
	y := run(t, dir, home, env, true, "", "ai", "setup", "--yes")
	decode(t, y.out, &p)
	if y.code != 0 || !p.Written || !exists(dir, "CLAUDE.md") {
		t.Errorf("--yes: exit %d %s%s", y.code, y.out, y.errOut)
	}
	// The project file's workspace is the person's to choose
	d := run(t, dir, home, env, true, "", "ai", "setup", "--with", "defaults", "--yes")
	if d.code != 5 || !strings.Contains(d.errOut, "AGENT_NOT_ALLOWED") || exists(dir, ".caitlyn.toml") {
		t.Errorf("defaults: exit %d %s", d.code, d.errOut)
	}
	// Removing needs --yes too
	if rm := run(t, dir, home, env, true, "", "ai", "remove"); rm.code != 3 || !exists(dir, "CLAUDE.md") {
		t.Errorf("remove: exit %d %s", rm.code, rm.errOut)
	}
}

func TestRefusesCredentialsInTheMCPEntry(t *testing.T) {
	for _, field := range []string{"headers", "env"} {
		entry := `{"mcpServers":{"caitlyn":{"type":"http","url":"https://acme.caitlyn.ai/api/mcp","` + field + `":{"X":"secret"}}}}`
		dir := project(t, map[string]string{".mcp.json": entry})
		r := run(t, dir, t.TempDir(), ws, false, "", "ai", "setup", "--yes")
		if r.code != 2 || !strings.Contains(r.errOut, "MCP_ENTRY_HAS_CREDENTIALS") {
			t.Errorf("%s: exit %d %s", field, r.code, r.errOut)
		}
		if read(t, dir, ".mcp.json") != entry || exists(dir, "CLAUDE.md") {
			t.Errorf("%s: something was written", field)
		}
		// remove leaves it alone too
		rm := run(t, dir, t.TempDir(), ws, false, "", "ai", "remove", "--yes")
		if rm.code != 0 || read(t, dir, ".mcp.json") != entry {
			t.Errorf("%s: remove: exit %d %s", field, rm.code, rm.errOut)
		}
	}
}

func TestRefusesALinkedFile(t *testing.T) {
	dir := project(t, nil)
	target := filepath.Join(t.TempDir(), "elsewhere.md")
	_ = os.WriteFile(target, []byte("mine\n"), 0o644)
	if err := os.Symlink(target, filepath.Join(dir, "AGENTS.md")); err != nil {
		t.Skip(err)
	}
	r := run(t, dir, t.TempDir(), ws, false, "", "ai", "setup", "--yes")
	if b, _ := os.ReadFile(target); r.code != 2 || string(b) != "mine\n" || !strings.Contains(r.errOut, "SYMBOLIC_LINK_REFUSED") {
		t.Errorf("exit %d %s, target %q", r.code, r.errOut, b)
	}
}

func TestInteractiveSetup(t *testing.T) {
	dir := project(t, map[string]string{".cursor/": "", "CLAUDE.md": "# Notes\n"})
	home := t.TempDir()
	// Enter keeps the ticked offers; then 2 shows the changes in full, and 1 writes
	r := run(t, dir, home, ws, true, "\n2\n1\n", "ai", "setup", "--no-pager", "--no-color")
	if r.code != 0 {
		t.Fatalf("exit %d\n%s\n%s", r.code, r.out, r.errOut)
	}
	for _, s := range []string{"AI coding tools in ", "Claude Code (CLAUDE.md)", "Cursor (.cursor/)", "Workspace  acme.caitlyn.ai", "AI tools may: read only (agent_scopes)",
		"Plan (nothing written yet)", "change  CLAUDE.md", "(@AGENTS.md)", "No credentials are written.", "+++ b/AGENTS.md"} {
		if !strings.Contains(r.out, s) {
			t.Errorf("output lacks %q:\n%s", s, r.out)
		}
	}
	for _, s := range []string{"What should they get?", "Project defaults: this project uses acme.caitlyn.ai", "Write these 6 files?", "Wrote 6 files.", "Commit them to share with your team", "caitlyn ai status"} {
		if !strings.Contains(r.errOut, s) {
			t.Errorf("stderr lacks %q:\n%s", s, r.errOut)
		}
	}
	if exists(dir, ".caitlyn.toml") {
		t.Error("project defaults were written without being ticked")
	}
	// No writes nothing
	dir2 := project(t, map[string]string{".cursor/": ""})
	n := run(t, dir2, home, ws, true, "\n3\n", "ai", "setup")
	if n.code != 3 || exists(dir2, "AGENTS.md") {
		t.Errorf("declined: exit %d", n.code)
	}
	// --no-input at a terminal: nobody may be asked, so --yes is needed
	ni := run(t, dir2, home, ws, true, "", "ai", "setup", "--no-input", "--output", "text")
	if ni.code != 3 || exists(dir2, "AGENTS.md") || !strings.Contains(ni.errOut, "--yes") {
		t.Errorf("--no-input: exit %d %s", ni.code, ni.errOut)
	}
}

func TestProjectDefaults(t *testing.T) {
	dir := project(t, map[string]string{".caitlyn.toml": "# ours\nagent = \"GHT7YRWXPL\"\n"})
	r := run(t, dir, t.TempDir(), ws, false, "", "ai", "setup", "--with", "defaults", "--yes", "--output", "json")
	if r.code != 0 {
		t.Fatalf("exit %d %s", r.code, r.errOut)
	}
	if got := read(t, dir, ".caitlyn.toml"); got != "# ours\nagent = \"GHT7YRWXPL\"\nworkspace = \"acme.caitlyn.ai\"\n" {
		t.Errorf(".caitlyn.toml:\n%s", got)
	}
}

// newFactory is a factory for a person (or not) at a terminal in work.
func newFactory(t *testing.T, work, home, in string, tty bool) (*cmdutil.Factory, *iostreams.IOStreams) {
	t.Helper()
	io, _, _ := iostreams.Test(in)
	io.Environ = []string{"CAITLYN_CONFIG_DIR=" + filepath.Join(home, ".caitlyn")}
	io.SetTTY(tty, tty, tty)
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Version: spec.MustLoad().Version, Now: time.Now, Home: home, WorkDir: work}
	// the design system draws on these streams, not an earlier run's
	gen.UIFor = func(*cmdutil.Factory) *ui.UI { return ui.New(io) }
	return f, io
}

func TestSignInOfferConditions(t *testing.T) {
	home := t.TempDir()
	withTool := project(t, map[string]string{".claude/": ""})
	noTool := project(t, nil)
	loose := filepath.Join(home, "notes")
	_ = os.Mkdir(loose, 0o755)
	setUp := project(t, map[string]string{"AGENTS.md": describe.StampedSnippet(describe.NewStamp("0.1.0", ""))})
	declined := project(t, map[string]string{".cursor/": ""})
	if err := aisetup.Decline(filepath.Join(home, ".caitlyn"), declined, "2026-11-26"); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name         string
		work         string
		tty          bool
		mod          func(f *cmdutil.Factory)
		ask, pointer bool
	}{
		{name: "a person in a project with a tool", work: withTool, tty: true, ask: true},
		{name: "no terminal", work: withTool, tty: false},
		{name: "CI", work: withTool, tty: true, mod: func(f *cmdutil.Factory) { f.CI = ci.Provider{Name: "gitlab"} }},
		{name: "an AI tool", work: withTool, tty: true, mod: func(f *cmdutil.Factory) { f.Agent = agent.Mode{On: true, Name: "claude-code"} }},
		{name: "--no-input", work: withTool, tty: true, mod: func(f *cmdutil.Factory) { f.Globals.NoInput = true }},
		{name: "stdout isn't a terminal", work: withTool, tty: true, mod: func(f *cmdutil.Factory) { f.IO.SetTTY(true, false, true) }},
		{name: "outside a project", work: loose, tty: true, pointer: true},
		{name: "no tool in the project", work: noTool, tty: true, pointer: true},
		{name: "already set up", work: setUp, tty: true},
		{name: "declined", work: declined, tty: true},
	}
	for _, c := range cases {
		f, _ := newFactory(t, c.work, home, "", c.tty)
		if c.mod != nil {
			c.mod(f)
		}
		o := aisetup.OfferFor(f)
		if o.Ask != c.ask || o.Pointer != c.pointer {
			t.Errorf("%s: ask %v pointer %v (%s)", c.name, o.Ask, o.Pointer, o.Why)
		}
	}
}

// signInCommand builds the CLI's tree and returns its auth login command, which the offer runs setup from.
func signInCommand(t *testing.T, f *cmdutil.Factory) *cobra.Command {
	t.Helper()
	register()
	u := ui.New(f.IO)
	r, err := root.New(f, &u)
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := r.Find([]string{"auth", "login"})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSignInOfferDontAskAgain(t *testing.T) {
	home := t.TempDir()
	dir := project(t, map[string]string{".cursor/": ""})
	f, io := newFactory(t, dir, home, "3\n", true)
	if err := aisetup.OfferAfterSignIn(f, signInCommand(t, f), "acme.caitlyn.ai", "default", nil); err != nil {
		t.Fatal(err)
	}
	errOut := io.ErrOut.(interface{ String() string }).String()
	if !strings.Contains(errOut, "uses Cursor.") || !strings.Contains(errOut, "Set it up to work with Caitlyn?") || !strings.Contains(errOut, "You won't be asked again here.") {
		t.Errorf("stderr:\n%s", errOut)
	}
	// Remembered in the user folder, keyed by the project, never in the repository
	if !aisetup.Declined(filepath.Join(home, ".caitlyn"), dir) || exists(dir, ".caitlyn.toml") || exists(dir, "AGENTS.md") {
		t.Error("not remembered, or written into the project")
	}
	f2, _ := newFactory(t, dir, home, "", true)
	if o := aisetup.OfferFor(f2); o.Ask || o.Why != "declined" {
		t.Errorf("asked again: %+v", o)
	}
}

func TestSignInOfferYesRunsSetup(t *testing.T) {
	home := t.TempDir()
	dir := project(t, map[string]string{".claude/": ""})
	// 1: yes; Enter: the ticked offers; 1: write them
	f, io := newFactory(t, dir, home, "1\n\n1\n", true)
	if err := aisetup.OfferAfterSignIn(f, signInCommand(t, f), "acme.caitlyn.ai", "default", []string{"read-only"}); err != nil {
		t.Fatal(err)
	}
	errOut := io.ErrOut.(interface{ String() string }).String()
	if !strings.Contains(errOut, "Wrote 4 files.") {
		t.Fatalf("stderr:\n%s\nstdout:\n%s", errOut, io.Out.(interface{ String() string }).String())
	}
	if !strings.Contains(read(t, dir, "CLAUDE.md"), "(workspace: acme.caitlyn.ai)") || !exists(dir, ".mcp.json") {
		t.Error("setup didn't use the workspace just signed in to")
	}
	// Set up now: no question next time
	f2, _ := newFactory(t, dir, home, "", true)
	if o := aisetup.OfferFor(f2); o.Ask || o.Why != "already set up" {
		t.Errorf("asked again: %+v", o)
	}
}

func TestSignInOfferPointer(t *testing.T) {
	home := t.TempDir()
	loose := filepath.Join(home, "notes")
	_ = os.Mkdir(loose, 0o755)
	f, io := newFactory(t, loose, home, "", true)
	_ = aisetup.OfferAfterSignIn(f, signInCommand(t, f), "acme.caitlyn.ai", "default", nil)
	if got := io.ErrOut.(interface{ String() string }).String(); !strings.Contains(got, "Using an AI coding tool? Run caitlyn ai setup in your project.") {
		t.Errorf("stderr: %q", got)
	}
	// Quiet without a terminal
	f, io = newFactory(t, loose, home, "", false)
	_ = aisetup.OfferAfterSignIn(f, signInCommand(t, f), "acme.caitlyn.ai", "default", nil)
	if got := io.ErrOut.(interface{ String() string }).String(); got != "" {
		t.Errorf("not quiet: %q", got)
	}
}
