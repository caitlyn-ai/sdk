// Package aisetup is `caitlyn ai setup`, `caitlyn ai status` and `caitlyn ai remove`: it makes the AI coding tools a
// project uses (Claude Code, Cursor, Codex, GitHub Copilot in VS Code, Gemini CLI) Caitlyn-aware, from the pieces the
// describe package already makes: the instructions section (describe.AgentsSnippet), the CLI's Claude Code skill
// (describe.Skill) and the workspace MCP server's entry (describe.PlanMCP). It shows the plan, and writes only what
// the person accepts.
//
// Everything it writes carries its own marker (describe.Stamp), so status and remove work in a repository a teammate
// only cloned: there is no manifest. It writes only inside the project, never credentials, and an AI tool running it
// sees the plan as JSON and needs --yes to write, because these files tell AI tools how to behave.
//
// Sign-in offers it once, in a project where a tool is found (OfferAfterSignIn), and the welcome screen lists it.
package aisetup

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Tool is an AI coding tool setup knows: how to find it in a project, and what it reads.
type Tool struct {
	Name    string
	Aliases []string
	Label   string
	// Markers are files and folders (ending in /) in the project that show it is used there: they pre-select it.
	Markers []string
	// Commands on PATH and folders in the home folder only suggest it, unselected.
	Commands []string
	HomeDirs []string
	// Instructions is the file it reads the instructions section from, relative to the project.
	Instructions string
	// MCP is the describe.MCPClients client whose file connects it to the workspace's MCP server, "" for none yet.
	MCP string
	// Skill is whether it takes the CLI's skill (.claude/skills/caitlyn/).
	Skill bool
	// Agents are the agent-mode names (agent.Markers) it runs under.
	Agents []string
}

// The instruction files.
const (
	agentsMD  = "AGENTS.md"
	claudeMD  = "CLAUDE.md"
	copilotMD = ".github/copilot-instructions.md"
	geminiMD  = "GEMINI.md"
	skillDir  = ".claude/skills/caitlyn"
)

// Tools are the tools setup knows, in the order it lists them. The paths are each tool's project conventions as
// they documented them (reviewed each release, like agent.Markers): Claude Code reads CLAUDE.md, which can import
// AGENTS.md with an @AGENTS.md line, and skills from .claude/skills/; Cursor and Codex read AGENTS.md; Copilot in VS
// Code reads .github/copilot-instructions.md; Gemini CLI reads GEMINI.md.
var Tools = []*Tool{
	{
		Name: "claude-code", Aliases: []string{"claude"}, Label: "Claude Code",
		Markers: []string{claudeMD, ".claude/", ".mcp.json"}, Commands: []string{"claude"}, HomeDirs: []string{".claude"},
		Instructions: claudeMD, MCP: "claude-code", Skill: true, Agents: []string{"claude-code"},
	},
	{
		Name: "cursor", Label: "Cursor",
		Markers: []string{".cursor/", ".cursorrules"}, Commands: []string{"cursor"}, HomeDirs: []string{".cursor"},
		Instructions: agentsMD, MCP: "cursor", Agents: []string{"cursor"},
	},
	{
		Name: "codex", Label: "Codex",
		Markers: []string{agentsMD, ".codex/"}, Commands: []string{"codex"}, HomeDirs: []string{".codex"},
		Instructions: agentsMD, Agents: []string{"codex"},
	},
	{
		Name: "copilot", Aliases: []string{"github-copilot", "vscode"}, Label: "GitHub Copilot (VS Code)",
		Markers: []string{copilotMD, ".vscode/mcp.json"}, Commands: []string{"code"},
		Instructions: copilotMD, MCP: "vscode", Agents: []string{"github-copilot"},
	},
	{
		Name: "gemini-cli", Aliases: []string{"gemini"}, Label: "Gemini CLI",
		Markers: []string{geminiMD, ".gemini/"}, Commands: []string{"gemini"},
		Instructions: geminiMD, Agents: []string{"gemini-cli"},
	},
}

// FindTool finds a tool by name or alias.
func FindTool(name string) *Tool {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, t := range Tools {
		if t.Name == name {
			return t
		}
		for _, a := range t.Aliases {
			if a == name {
				return t
			}
		}
	}
	return nil
}

// ToolNames are the tools' names.
func ToolNames() []string {
	out := make([]string, len(Tools))
	for i, t := range Tools {
		out[i] = t.Name
	}
	return out
}

// toolForAgent is the tool an agent-mode name is, nil for one setup doesn't know.
func toolForAgent(name string) *Tool {
	for _, t := range Tools {
		for _, a := range t.Agents {
			if a == name {
				return t
			}
		}
	}
	return nil
}

// ProjectRoot is the project the working folder is in: the nearest folder above it (or it) with .git or
// .caitlyn.toml, stopping at the home folder. ok is false outside any project, and root is then the working folder.
func ProjectRoot(workDir, home string) (root string, ok bool) {
	d := filepath.Clean(workDir)
	for {
		for _, m := range []string{".git", ".caitlyn.toml"} {
			if _, err := os.Stat(filepath.Join(d, m)); err == nil {
				return d, true
			}
		}
		if home != "" && d == filepath.Clean(home) {
			return workDir, false
		}
		parent := filepath.Dir(d)
		if parent == d {
			return workDir, false
		}
		d = parent
	}
}

// Detection is a tool found for a project: by its markers in the project (selected), or only by hints on this machine
// (offered, unselected), or because it is the AI tool running the CLI.
type Detection struct {
	Tool    *Tool    `json:"-"`
	Name    string   `json:"name"`
	Label   string   `json:"label"`
	Markers []string `json:"markers,omitempty"`
	Hints   []string `json:"hints,omitempty"`
	Running bool     `json:"running,omitempty"`
}

// Selected reports whether the tool is pre-selected: it has markers in the project, or it is running the CLI.
func (d Detection) Selected() bool { return len(d.Markers) > 0 || d.Running }

// Env is what detection reads besides the project: the home folder, the environment (PATH), and the agent running
// the CLI, if any.
type Env struct {
	Home   string
	Getenv func(string) string
	Agent  string
}

// Detect finds the tools a project uses.
func Detect(root string, env Env) []Detection {
	var out []Detection
	running := toolForAgent(env.Agent)
	for _, t := range Tools {
		d := Detection{Tool: t, Name: t.Name, Label: t.Label, Running: t == running && running != nil}
		for _, m := range t.Markers {
			fi, err := os.Stat(filepath.Join(root, filepath.FromSlash(strings.TrimSuffix(m, "/"))))
			if err == nil && fi.IsDir() == strings.HasSuffix(m, "/") {
				d.Markers = append(d.Markers, m)
			}
		}
		for _, c := range t.Commands {
			if onPath(c, env.Getenv) {
				d.Hints = append(d.Hints, c+" on PATH")
			}
		}
		for _, h := range t.HomeDirs {
			if env.Home == "" {
				continue
			}
			if fi, err := os.Stat(filepath.Join(env.Home, h)); err == nil && fi.IsDir() {
				d.Hints = append(d.Hints, "~/"+h+"/")
			}
		}
		if d.Selected() || len(d.Hints) > 0 {
			out = append(out, d)
		}
	}
	return out
}

// onPath reports whether an executable of that name is in one of PATH's folders.
func onPath(name string, getenv func(string) string) bool {
	if getenv == nil {
		return false
	}
	names := []string{name}
	if runtime.GOOS == "windows" {
		names = []string{name + ".exe", name + ".cmd", name + ".bat"}
	}
	for _, dir := range filepath.SplitList(getenv("PATH")) {
		if dir == "" {
			continue
		}
		for _, n := range names {
			fi, err := os.Stat(filepath.Join(dir, n))
			if err == nil && !fi.IsDir() && (runtime.GOOS == "windows" || fi.Mode()&0o111 != 0) {
				return true
			}
		}
	}
	return false
}

// labels joins tools' labels: "Claude Code and Cursor".
func labels(tools []*Tool) string {
	l := make([]string, len(tools))
	for i, t := range tools {
		l[i] = t.Label
	}
	switch len(l) {
	case 0:
		return ""
	case 1:
		return l[0]
	}
	return strings.Join(l[:len(l)-1], ", ") + " and " + l[len(l)-1]
}

// sortedNames are tools' names in the order Tools lists them.
func sortedNames(names map[string]bool) []string {
	var out []string
	for _, t := range Tools {
		if names[t.Name] {
			out = append(out, t.Name)
		}
	}
	var rest []string
	for n := range names {
		if FindTool(n) == nil {
			rest = append(rest, n)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}
