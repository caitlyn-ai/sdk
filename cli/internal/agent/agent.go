// Package agent detects when an AI agent is running the CLI (the CLI design, 18.1). In agent mode the CLI never
// prompts, prints JSON by default, decorates nothing, gives every error a hint, and asks for --yes before anything
// destructive or user-facing.
package agent

import (
	"github.com/caitlyn-ai/sdk/cli/internal/useragent"
	"os"
	"strings"
)

// Marker is one way an agent tool shows itself.
type Marker struct {
	// Name is the tool, as the user agent's agent/<name> token and usage data for Caitlyn give it.
	Name string
	// Env is the variable; Value, when set, is the value it must have.
	Env, Value string
	// File is a file whose presence is the marker (Devin's /opt/.devin).
	File string
	// IDEWide markers are also set in a person's terminal inside the same IDE, so they count only without a TTY.
	IDEWide bool
	// Source says who documents the marker.
	Source string
}

// Markers is the list, reviewed each release (18.1). Order matters only for the name reported when several match.
var Markers = []Marker{
	{Name: "claude-code", Env: "CLAUDE_CODE_CHILD_SESSION", Source: "Claude Code's environment-variable docs: tool subprocesses, hooks and status-line commands"},
	{Name: "codex", Env: "CODEX_SANDBOX", Source: "Vercel's @vercel/detect-agent"},
	{Name: "codex", Env: "CODEX_THREAD_ID", Source: "Vercel's @vercel/detect-agent"},
	{Name: "codex", Env: "CODEX_CI", Source: "Vercel's @vercel/detect-agent"},
	{Name: "cursor", Env: "CURSOR_AGENT", Source: "Vercel's @vercel/detect-agent"},
	{Name: "cursor", Env: "CURSOR_EXTENSION_HOST_ROLE", Value: "agent-exec", Source: "Vercel's @vercel/detect-agent"},
	{Name: "gemini-cli", Env: "GEMINI_CLI", Source: "Vercel's @vercel/detect-agent"},
	{Name: "github-copilot", Env: "COPILOT_MODEL", Source: "Vercel's @vercel/detect-agent"},
	{Name: "github-copilot", Env: "COPILOT_ALLOW_ALL", Source: "Vercel's @vercel/detect-agent"},
	{Name: "github-copilot", Env: "COPILOT_GITHUB_TOKEN", Source: "Vercel's @vercel/detect-agent"},
	{Name: "opencode", Env: "OPENCODE", Source: "Vercel's @vercel/detect-agent"},
	{Name: "opencode", Env: "OPENCODE_CLIENT", Source: "Vercel's @vercel/detect-agent"},
	{Name: "augment", Env: "AUGMENT_AGENT", Source: "Vercel's @vercel/detect-agent"},
	{Name: "antigravity", Env: "ANTIGRAVITY_AGENT", Source: "Vercel's @vercel/detect-agent"},
	{Name: "devin", File: "/opt/.devin", Source: "Vercel's @vercel/detect-agent"},
	// Set in every terminal of the IDE as well as the agent's own shell: they count only when stdin is not a TTY
	{Name: "claude-code", Env: "CLAUDECODE", IDEWide: true, Source: "Claude Code's environment-variable docs: also set in IDE integrated terminals"},
	{Name: "cursor", Env: "CURSOR_TRACE_ID", IDEWide: true, Source: "Vercel's @vercel/detect-agent; likely set in every Cursor terminal"},
}

// Mode is the detection's result.
type Mode struct {
	// On is agent mode.
	On bool
	// Name is the agent's name ("claude-code"), "" when unknown or off.
	Name string
	// Reason is what decided it: the variable or file, or CAITLYN_AGENT.
	Reason string
}

// Env is what detection reads.
type Env struct {
	Lookup     func(string) (string, bool)
	StdinTTY   bool
	FileExists func(string) bool
}

// Detect applies the rule in 18.1:
//
//  1. CAITLYN_AGENT=1 always wins. CAITLYN_AGENT=0 turns agent mode off, but only when stdin is a terminal: an
//     agent's shell has none, so an agent can't use it to escape its agent scopes (18.5);
//  2. a subprocess-only marker;
//  3. an IDE-wide marker, when stdin is not a terminal.
func Detect(e Env) Mode {
	if e.FileExists == nil {
		e.FileExists = func(p string) bool { _, err := os.Stat(p); return err == nil }
	}
	explicit, set := e.Lookup("CAITLYN_AGENT")
	switch {
	case set && truthy(explicit):
		return Mode{On: true, Name: nameFromAIAgent(e), Reason: "CAITLYN_AGENT"}
	case set && explicit == "0" && e.StdinTTY:
		return Mode{Reason: "CAITLYN_AGENT=0"}
	}
	if v, ok := e.Lookup("AI_AGENT"); ok && v != "" {
		return Mode{On: true, Name: normalise(v), Reason: "AI_AGENT"}
	}
	for _, m := range Markers {
		if m.IDEWide {
			continue
		}
		if m.matches(e) {
			return Mode{On: true, Name: m.Name, Reason: m.reason()}
		}
	}
	if !e.StdinTTY {
		for _, m := range Markers {
			if m.IDEWide && m.matches(e) {
				return Mode{On: true, Name: m.Name, Reason: m.reason() + " without a terminal"}
			}
		}
	}
	return Mode{}
}

func (m Marker) matches(e Env) bool {
	if m.File != "" {
		return e.FileExists(m.File)
	}
	v, ok := e.Lookup(m.Env)
	if !ok || v == "" {
		return false
	}
	return m.Value == "" || v == m.Value
}

func (m Marker) reason() string {
	if m.File != "" {
		return m.File
	}
	return m.Env
}

func nameFromAIAgent(e Env) string {
	if v, ok := e.Lookup("AI_AGENT"); ok && v != "" {
		return normalise(v)
	}
	for _, m := range Markers {
		if m.matches(e) {
			return m.Name
		}
	}
	return ""
}

// normalise keeps an agent name safe for the user agent and usage data for Caitlyn: useragent.Token, or "unknown"
// when nothing valid is left.
func normalise(s string) string {
	if t := useragent.Token(s); t != "" {
		return t
	}
	return "unknown"
}

func truthy(v string) bool {
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
