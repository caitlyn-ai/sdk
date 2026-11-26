// Package describe makes the CLI describe itself, for AI agents and for the docs (the CLI design, 10.2, 18.3, 18.4
// and 20): `caitlyn commands` prints the whole command tree, `caitlyn help <command> --format json|markdown` one
// command, `caitlyn help agents` the AGENTS.md snippet and the Claude Code skill, `caitlyn docs <command>` opens the
// command's page, and `caitlyn mcp add <client>` connects an AI client to the workspace's MCP server.
//
// Everything is built from the live command tree, so commands added by other packages appear without any change
// here, and from the command manifest for what the model knows about each generated command. The docs build reads the
// same description (docs/cli/tree.json, written by this package's tests), so the site, the installed binary and the
// skill can never say different things.
package describe

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/go/core"
)

// SchemaVersion is the version of the JSON `caitlyn commands` and `caitlyn help --format json` print. It changes
// only when a field is removed or changes meaning; new fields are added without a change.
const SchemaVersion = 1

// Annotations a hand-written command may set on its cobra command, so the tree describes it as fully as a generated
// one. Generated commands get them from the manifest.
const (
	// AnnotationImpact is read, write, user-facing or destructive (18.5). Unset, a hand-written command is "write":
	// an agent is told to treat it with care rather than assume it only reads.
	AnnotationImpact = "impact"
	// AnnotationExitCodes is a comma-separated list of the exit codes the command can end with, besides 0 and 2.
	AnnotationExitCodes = "exitCodes"
	// AnnotationLongRunning is "true" for a command that waits for work to finish (it takes --timeout).
	AnnotationLongRunning = "longRunning"
	// AnnotationInteractive is "true" for a command that only works with a person at a terminal.
	AnnotationInteractive = "interactiveOnly"
	// AnnotationScope is the OAuth scope the command needs, when it calls Caitlyn.
	AnnotationScope = "scope"
	// AnnotationOperations is a comma-separated list of the operations a hand-written command calls.
	AnnotationOperations = "operations"
	// AnnotationStability is "beta" for a beta command.
	AnnotationStability = "stability"
)

// Tree is the whole command tree, as `caitlyn commands --output json` prints it.
type Tree struct {
	SchemaVersion int    `json:"schemaVersion"`
	CLI           CLI    `json:"cli"`
	Agent         *Agent `json:"agentMode"`
	// GlobalFlags are the flags every command takes.
	GlobalFlags  []*Flag          `json:"globalFlags"`
	ExitCodes    []exitcode.Entry `json:"exitCodes"`
	Alternatives Alternatives     `json:"alternatives"`
	Docs         DocsLinks        `json:"docs"`
	Commands     []*Command       `json:"commands"`
	// Errors are the error codes any command can return, each with its status, exit code and the hint the CLI
	// gives with it.
	Errors map[string]*ErrorCode `json:"errors"`
}

// CLI is the binary's own version and the model it was built from.
type CLI struct {
	Version      string `json:"version"`
	ModelVersion string `json:"modelVersion"`
}

// Agent is whether the CLI is in agent mode for this run, and why (18.1).
type Agent struct {
	On     bool   `json:"on"`
	Name   string `json:"name,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// Alternatives are the other tools that are better than the CLI for some work (18.3).
type Alternatives struct {
	MCP MCPAlternatives `json:"mcp"`
}

// MCPAlternatives are the two MCP servers.
type MCPAlternatives struct {
	Workspace    MCPServer `json:"workspace"`
	Integrations MCPServer `json:"integrations"`
}

// MCPServer is one MCP server and what it is better at than the CLI.
type MCPServer struct {
	Description string   `json:"description"`
	URL         string   `json:"url,omitempty"`
	Transport   string   `json:"transport,omitempty"`
	Auth        string   `json:"auth,omitempty"`
	BetterFor   []string `json:"betterFor"`
	Connect     string   `json:"connect,omitempty"`
	Status      string   `json:"status"`
}

// DocsLinks are the docs written for agents.
type DocsLinks struct {
	Home      string `json:"home"`
	LLMs      string `json:"llms"`
	LLMsFull  string `json:"llmsFull"`
	ExitCodes string `json:"exitCodes"`
	AIAgents  string `json:"aiAgents"`
}

// Command is one command or command group.
type Command struct {
	Path []string `json:"path"`
	// Name is the path as typed after `caitlyn`.
	Name    string   `json:"name"`
	Kind    string   `json:"kind"` // "command" or "group"
	Aliases []string `json:"aliases,omitempty"`
	Summary string   `json:"summary"`
	// Description is the command's long help in plain text.
	Description string `json:"description,omitempty"`
	Usage       string `json:"usage"`
	Hidden      bool   `json:"hidden,omitempty"`
	Generated   bool   `json:"generated"`
	// Subcommands of a group, by name.
	Subcommands []string `json:"subcommands,omitempty"`
	Args        []*Arg   `json:"args,omitempty"`
	Flags       []*Flag  `json:"flags,omitempty"`
	// Impact is read, write, user-facing or destructive (18.5).
	Impact string `json:"impact,omitempty"`
	// Confirm names the target --confirm must repeat in agent mode and CI (the highest-impact commands).
	Confirm     string `json:"confirm,omitempty"`
	LongRunning bool   `json:"longRunning,omitempty"`
	// Stream is true for a command that prints a stream of events, one JSON object per line with --output jsonl.
	Stream          bool        `json:"stream,omitempty"`
	InteractiveOnly bool        `json:"interactiveOnly,omitempty"`
	Beta            bool        `json:"beta,omitempty"`
	Since           string      `json:"since,omitempty"`
	Permission      *Permission `json:"permission,omitempty"`
	// Operation is the API operation behind a generated command; Operations the ones a hand-written one calls.
	Operation  string   `json:"operation,omitempty"`
	Operations []string `json:"operations,omitempty"`
	// SDK is the same call in the SDKs (caitlyn.agents(agentId).draft.save), and HTTP the request.
	SDK       string     `json:"sdk,omitempty"`
	HTTP      *HTTP      `json:"http,omitempty"`
	ExitCodes []int      `json:"exitCodes"`
	Errors    []*Error   `json:"errors,omitempty"`
	Examples  []*Example `json:"examples,omitempty"`
	Docs      string     `json:"docs"`
}

// Arg is a positional argument.
type Arg struct {
	Name     string `json:"name"`
	Required bool   `json:"required"`
	// Identifier is the scope identifier it fills (agentId); Version is true when it takes AGENT@version.
	Identifier string `json:"identifier,omitempty"`
	Version    bool   `json:"version,omitempty"`
	File       bool   `json:"file,omitempty"`
	Repeatable bool   `json:"repeatable,omitempty"`
}

// Flag is one flag.
type Flag struct {
	Name      string   `json:"name"`
	Shorthand string   `json:"shorthand,omitempty"`
	Aliases   []string `json:"aliases,omitempty"`
	// Type is the value's type: string, bool, int, duration, stringArray (repeatable), and so on.
	Type string `json:"type"`
	// ValueType is the member's type when the flag sets an input member: string, integer, number, boolean, enum,
	// timestamp, or a list of one of those.
	ValueType  string   `json:"valueType,omitempty"`
	Enum       []string `json:"enum,omitempty"`
	Required   bool     `json:"required,omitempty"`
	Default    string   `json:"default,omitempty"`
	NoOptValue string   `json:"noOptValue,omitempty"`
	Repeatable bool     `json:"repeatable,omitempty"`
	// Member is the input member the flag sets (its wire name), Identifier the scope identifier it names.
	Member     string   `json:"member,omitempty"`
	Identifier string   `json:"identifier,omitempty"`
	Secret     bool     `json:"secret,omitempty"`
	Pattern    string   `json:"pattern,omitempty"`
	Min        *float64 `json:"min,omitempty"`
	Max        *float64 `json:"max,omitempty"`
	MinLength  *float64 `json:"minLength,omitempty"`
	MaxLength  *float64 `json:"maxLength,omitempty"`
	Env        string   `json:"env,omitempty"`
	Hidden     bool     `json:"hidden,omitempty"`
	// Impact, when set, is the command's impact class when this flag is given (help --write writes files).
	Impact string `json:"impact,omitempty"`
	// Global flags are the root's, which every command takes.
	Global      bool   `json:"global,omitempty"`
	Description string `json:"description"`
}

// Permission is what a command needs from the caller.
type Permission struct {
	Action string `json:"action"`
	Scope  string `json:"scope,omitempty"`
	// Grant is the access needed on the thing ("update on the agent"), when the permission checks one.
	Grant   string   `json:"grant,omitempty"`
	Callers []string `json:"callers,omitempty"`
}

// HTTP is a generated command's request.
type HTTP struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

// Error is an error code a command can return.
type Error struct {
	Code     string `json:"code"`
	Status   int    `json:"status"`
	ExitCode int    `json:"exitCode"`
}

// Example is one @examples entry as a command line.
type Example struct {
	Title string `json:"title"`
	Line  string `json:"line"`
	// Error is the code an error example fails with.
	Error    string `json:"error,omitempty"`
	ExitCode int    `json:"exitCode"`
}

// ErrorCode is an error code, what the CLI does with it, and which commands can return it.
type ErrorCode struct {
	Code     string `json:"code"`
	Status   int    `json:"status"`
	ExitCode int    `json:"exitCode"`
	// Hint is the hint the CLI gives with it, as it would for the first command that returns it.
	Hint *cmdutil.Hint `json:"hint,omitempty"`
	// HintFrom is where the hint comes from: "overlay" (the naming overlay's next steps for this code), "exit" (the
	// steps every error of its exit code gets), "fields" (each field error named by the flag that set it), or ""
	// (none yet).
	HintFrom string `json:"hintFrom"`
	// HintCommand is the command the hint was worked out for.
	HintCommand string   `json:"hintCommand,omitempty"`
	Commands    []string `json:"commands"`
}

// Options say how the tree is built.
type Options struct {
	// IncludeHidden keeps hidden commands (core, and cobra's own completion requests are never kept).
	IncludeHidden bool
}

// Build describes the live tree under root.
func Build(root *cobra.Command, f *cmdutil.Factory, opts Options) *Tree {
	m := spec.MustLoad()
	t := &Tree{
		SchemaVersion: SchemaVersion,
		CLI:           CLI{Version: f.Version, ModelVersion: m.ModelVersion},
		Agent:         &Agent{On: f.Agent.On, Name: f.Agent.Name, Reason: f.Agent.Reason},
		ExitCodes:     exitcode.Table,
		Alternatives:  alternatives(workspaceOf(f)),
		Docs: DocsLinks{
			Home:      gen.DocsURL(nil),
			LLMs:      "https://build.caitlyn.ai/cli/llms.txt",
			LLMsFull:  "https://build.caitlyn.ai/cli/llms-full.txt",
			ExitCodes: "https://build.caitlyn.ai/cli/exit-codes/",
			AIAgents:  "https://build.caitlyn.ai/cli/ai-agents/",
		},
		Errors: map[string]*ErrorCode{},
	}
	t.GlobalFlags = flags(root.PersistentFlags(), nil, true)
	walk(root, f, m, t, opts)
	sort.Slice(t.Commands, func(i, j int) bool { return t.Commands[i].Name < t.Commands[j].Name })
	errorCodes(root, f, m, t)
	return t
}

// workspaceOf is the profile's workspace, or "" when none is chosen (never an error: describing the CLI works
// signed out).
func workspaceOf(f *cmdutil.Factory) string {
	if f == nil || f.IO == nil {
		return ""
	}
	cfg, err := f.Config()
	if err != nil || cfg == nil {
		return ""
	}
	return cfg.String("workspace")
}

// Keep reports whether a command belongs in the description: not cobra's hidden completion requests (__complete).
func Keep(c *cobra.Command) bool {
	return !strings.HasPrefix(c.Name(), "__")
}

func walk(parent *cobra.Command, f *cmdutil.Factory, m *spec.Manifest, t *Tree, opts Options) {
	for _, c := range parent.Commands() {
		if !Keep(c) || (c.Hidden && !opts.IncludeHidden) {
			continue
		}
		t.Commands = append(t.Commands, Describe(c, f, m))
		walk(c, f, m, t, opts)
	}
}

// PathOf is a command's words after `caitlyn`.
func PathOf(c *cobra.Command) []string {
	var path []string
	for p := c; p != nil && p.HasParent(); p = p.Parent() {
		path = append([]string{p.Name()}, path...)
	}
	return path
}

// IsGroup reports whether a command is a group of others rather than a command that does something itself.
func IsGroup(c *cobra.Command) bool {
	if gen.Of(c) != nil {
		return false
	}
	for _, s := range c.Commands() {
		if Keep(s) && s.Name() != "help" {
			return true
		}
	}
	return false
}

// Describe describes one command.
func Describe(c *cobra.Command, f *cmdutil.Factory, m *spec.Manifest) *Command {
	path := PathOf(c)
	d := &Command{
		Path:      path,
		Name:      strings.Join(path, " "),
		Kind:      "command",
		Aliases:   append([]string(nil), c.Aliases...),
		Summary:   strings.TrimSpace(strings.TrimSuffix(c.Short, "  [Beta]")),
		Hidden:    hidden(c),
		Generated: gen.Of(c) != nil,
		Docs:      gen.DocsURL(path),
	}
	d.Usage = "caitlyn " + strings.TrimSpace(strings.Join(path[:max(0, len(path)-1)], " ")+" "+c.Use)
	d.Usage = strings.Join(strings.Fields(d.Usage), " ")
	if IsGroup(c) {
		d.Kind = "group"
		d.Docs = gen.GroupDocsURL(path)
		for _, s := range c.Commands() {
			// A hidden group's own commands are listed; a hidden command in a visible group is not
			if Keep(s) && (!s.Hidden || hidden(c)) {
				d.Subcommands = append(d.Subcommands, s.Name())
			}
		}
		sort.Strings(d.Subcommands)
	}
	d.Description = description(c)
	g := gen.Of(c)
	if g != nil && g.Op != nil && c.Annotations[root.AnnotationLongFromOverlay] == "" {
		// The model's own words; the rest of a generated command's help (what it needs, its impact, how it fails)
		// is in the fields below
		d.Description = clean(g.Op.Documentation)
	}
	d.Flags = flags(c.LocalNonPersistentFlags(), g, false)
	// A group's or a hand-written command's own persistent flags (a parent's, inherited) are listed too
	d.Flags = append(d.Flags, flags(c.InheritedFlags(), g, false, c.Root().PersistentFlags())...)
	if g != nil {
		describeGenerated(d, g, m)
	} else {
		describeHandWritten(d, c)
	}
	if g == nil || g.Op == nil {
		d.Examples = append(d.Examples, cobraExamples(c.Example)...)
	}
	d.ExitCodes = exitCodes(d, g, c.Annotations[AnnotationExitCodes])
	return d
}

// cobraExamples reads a hand-written command's (or a group's) Example text: each command line, titled by the
// `# …` comment line before it, if any.
func cobraExamples(text string) []*Example {
	var out []*Example
	title := ""
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
		case strings.HasPrefix(line, "#"):
			title = strings.TrimSpace(strings.TrimPrefix(line, "#"))
		default:
			out = append(out, &Example{Title: title, Line: line})
			title = ""
		}
	}
	return out
}

func hidden(c *cobra.Command) bool {
	for p := c; p != nil; p = p.Parent() {
		if p.Hidden {
			return true
		}
	}
	return false
}

// description is the long help as plain text: the model's documentation for a generated command, which help also
// shows, without the docs link at its end.
func description(c *cobra.Command) string {
	long := strings.TrimSpace(c.Long)
	if long == "" {
		return ""
	}
	lines := strings.Split(long, "\n")
	for len(lines) > 0 {
		last := strings.TrimSpace(lines[len(lines)-1])
		if strings.HasPrefix(last, "https://build.caitlyn.ai/") || strings.HasPrefix(last, "Docs: https://build.caitlyn.ai/") {
			lines = lines[:len(lines)-1]
			continue
		}
		if i := strings.Index(last, "https://build.caitlyn.ai/"); i > 0 && strings.HasPrefix(last, "Available from") {
			lines[len(lines)-1] = strings.TrimSpace(last[:i])
		}
		break
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func describeGenerated(d *Command, g *gen.Command, m *spec.Manifest) {
	d.Impact = g.Impact
	if g.Confirms != "" {
		d.Confirm = spec.MustOverlay().Name(g.Confirms).Arg
	}
	for _, p := range g.Positionals() {
		a := &Arg{Name: p.Name, Required: true, File: p.File}
		if p.Identifier != nil {
			a.Identifier = p.Identifier.Identifier
			a.Version = p.Identifier.Compact != nil
			a.Name = strings.TrimSuffix(a.Name, "[@version]")
		}
		d.Args = append(d.Args, a)
	}
	d.SDK = g.Spec.Place
	if g.Op == nil {
		// a wait: it follows a watch until nothing is running
		d.LongRunning = true
		return
	}
	op := g.Op
	d.Operation = op.Name
	d.Beta = op.Stability == "beta"
	d.Since = op.Since
	d.InteractiveOnly = op.Interactive
	d.LongRunning = g.Spec.LongRunning != nil || op.SSE != nil || (g.Spec.ScopeWatch != nil && g.Impact != "read")
	d.Stream = op.SSE != nil
	d.HTTP = &HTTP{Method: op.Method, Path: "/api" + op.URI}
	if op.Permission != nil {
		p := &Permission{Action: op.Permission.Action, Scope: op.Scope(), Callers: op.Permission.Callers}
		if lvl := op.Permission.Level(); lvl != "" {
			p.Grant = fmt.Sprintf("%s on the %s", lvl, singular(strings.ReplaceAll(op.Permission.EntityType(), "-", " ")))
		}
		d.Permission = p
	}
	for _, e := range op.Errors {
		for _, code := range e.Codes {
			d.Errors = append(d.Errors, &Error{Code: code, Status: e.Status, ExitCode: ExitFor(e.Status, code)})
		}
	}
	sort.Slice(d.Errors, func(i, j int) bool {
		if d.Errors[i].Status != d.Errors[j].Status {
			return d.Errors[i].Status < d.Errors[j].Status
		}
		return d.Errors[i].Code < d.Errors[j].Code
	})
	for _, ex := range op.Examples {
		line, ok := g.ExampleLine(ex)
		if !ok {
			continue
		}
		e := &Example{Title: ex.Title, Line: line}
		if ex.Error != nil {
			var p struct {
				Status int    `json:"status"`
				Code   string `json:"code"`
			}
			_ = json.Unmarshal(ex.Error.Content, &p)
			e.Error = p.Code
			e.ExitCode = ExitFor(p.Status, p.Code)
		}
		d.Examples = append(d.Examples, e)
	}
}

func describeHandWritten(d *Command, c *cobra.Command) {
	a := c.Annotations
	if d.Kind == "group" {
		return
	}
	d.Impact = a[AnnotationImpact]
	switch d.Impact {
	case "read", "write", "user-facing", "destructive":
	default:
		d.Impact = "write"
	}
	d.LongRunning = a[AnnotationLongRunning] == "true"
	d.InteractiveOnly = a[AnnotationInteractive] == "true"
	d.Beta = a[AnnotationStability] == "beta"
	if s := a[AnnotationScope]; s != "" {
		d.Permission = &Permission{Scope: s}
	}
	for _, op := range strings.Split(a[AnnotationOperations], ",") {
		if op = strings.TrimSpace(op); op != "" {
			d.Operations = append(d.Operations, op)
		}
	}
	d.Args = handWrittenArgs(c.Use)
}

// handWrittenArgs reads a hand-written command's positional arguments from its usage line:
// `login [workspace]`, `sync <kb> <dir>`, `add <client>`, `help [command]...`.
func handWrittenArgs(use string) []*Arg {
	var out []*Arg
	for _, w := range strings.Fields(use)[1:] {
		rep := strings.HasSuffix(w, "...") || strings.HasSuffix(w, "…")
		w = strings.TrimRight(w, ".…")
		switch {
		case strings.HasPrefix(w, "<") && strings.HasSuffix(w, ">"):
			out = append(out, &Arg{Name: strings.Trim(w, "<>"), Required: true, Repeatable: rep})
		case strings.HasPrefix(w, "[") && strings.HasSuffix(w, "]") && !strings.EqualFold(w, "[flags]"):
			// Only the outer brackets: [agent[@version]] is agent[@version]
			name := strings.TrimSuffix(strings.TrimPrefix(w, "["), "]")
			out = append(out, &Arg{Name: strings.Trim(name, "<>"), Repeatable: rep})
		}
	}
	return out
}

func singular(s string) string {
	switch {
	case strings.HasSuffix(s, "ies"):
		return strings.TrimSuffix(s, "ies") + "y"
	case strings.HasSuffix(s, "s"):
		return strings.TrimSuffix(s, "s")
	}
	return s
}

// ExitFor is the exit code an error with this status and code ends a command with (4.6).
func ExitFor(status int, code string) int {
	return cmdutil.FromError(&core.APIError{Status: status, Code: code}).Exit
}

// flags describes a flag set. skip, when given, leaves out the flags it also has (the root's persistent flags, listed
// once as GlobalFlags).
func flags(fs *pflag.FlagSet, g *gen.Command, global bool, skip ...*pflag.FlagSet) []*Flag {
	var out []*Flag
	// A flag's hidden short forms (--kb for --knowledge-base) are listed as its aliases, not as flags of their own
	aliasOf := map[string]string{}
	fs.VisitAll(func(fl *pflag.Flag) {
		if fl.Hidden && strings.HasPrefix(fl.Usage, "Short for --") {
			aliasOf[fl.Name] = strings.TrimPrefix(fl.Usage, "Short for --")
		}
	})
	byName := map[string]*Flag{}
	fs.VisitAll(func(fl *pflag.Flag) {
		for _, s := range skip {
			if s != nil && s.Lookup(fl.Name) != nil {
				return
			}
		}
		if _, ok := aliasOf[fl.Name]; ok || fl.Name == "help" {
			return
		}
		d := &Flag{
			Name:        fl.Name,
			Shorthand:   fl.Shorthand,
			Type:        fl.Value.Type(),
			Hidden:      fl.Hidden,
			Global:      global,
			Description: usage(fl.Usage),
		}
		if fl.DefValue != "" && fl.DefValue != "[]" && fl.DefValue != "false" && fl.DefValue != "0" {
			d.Default = fl.DefValue
		}
		if fl.NoOptDefVal != "" && fl.Value.Type() != "bool" {
			d.NoOptValue = fl.NoOptDefVal
		}
		d.Repeatable = strings.HasSuffix(d.Type, "Array") || strings.HasSuffix(d.Type, "Slice")
		if v, ok := fl.Annotations[cobra.BashCompOneRequiredFlag]; ok && len(v) > 0 && v[0] == "true" {
			d.Required = true
		}
		if v := fl.Annotations[AnnotationImpact]; len(v) > 0 {
			d.Impact = v[0]
		}
		if g != nil {
			if mem, secret, ok := g.FlagMember(fl.Name); ok {
				d.Member = mem.Wire
				d.Secret = secret
				d.Required = mem.Required && !secret
				d.ValueType = valueType(mem.Type)
				if mem.Type.Type == "list" && mem.Type.Member != nil {
					d.Enum = mem.Type.Member.Enum()
				} else {
					d.Enum = mem.Type.Enum()
				}
				d.Pattern = mem.Pattern
				if mem.Range != nil {
					d.Min, d.Max = mem.Range.Min, mem.Range.Max
				}
				if mem.Length != nil && mem.Type.Type == "string" {
					d.MinLength, d.MaxLength = mem.Length.Min, mem.Length.Max
				}
				if len(mem.Default) > 0 && d.Default == "" {
					var s any
					if json.Unmarshal(mem.Default, &s) == nil {
						d.Default = fmt.Sprint(s)
					}
				}
			} else if id := g.FlagIdentifier(fl.Name); id != nil {
				d.Identifier = id.Identifier
				if n := spec.MustOverlay().Name(id.Identifier); n.Default != "" {
					d.Env = "CAITLYN_" + strings.ToUpper(strings.ReplaceAll(n.Default, ".", "_"))
				}
			}
			if fl.Name == "clear" {
				if cl := g.Op.Member("clear"); cl != nil && cl.Type.Member != nil {
					d.Enum = cl.Type.Member.Enum()
				}
			}
		}
		if global {
			d.Env = globalEnv[fl.Name]
		}
		out = append(out, d)
		byName[fl.Name] = d
	})
	for alias, name := range aliasOf {
		if d := byName[name]; d != nil {
			d.Aliases = append(d.Aliases, alias)
			sort.Strings(d.Aliases)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// globalEnv are the variables that set a global flag's value when it is not given (13.4).
var globalEnv = map[string]string{
	"profile":      "CAITLYN_PROFILE",
	"workspace":    "CAITLYN_WORKSPACE",
	"output":       "CAITLYN_OUTPUT",
	"error-format": "CAITLYN_ERROR_FORMAT",
	"no-input":     "CAITLYN_NO_INPUT",
}

// usage is a flag's usage text without a trailing full stop's absence mattering: one sentence, as written.
func usage(s string) string {
	return strings.TrimSpace(strings.Join(strings.Fields(s), " "))
}

func valueType(t *spec.Type) string {
	if t == nil {
		return ""
	}
	if t.Type == "list" && t.Member != nil {
		return "list of " + valueType(t.Member)
	}
	switch t.Type {
	case "intEnum":
		return "enum"
	case "ref":
		return "object"
	}
	return t.Type
}

// exitCodes are the codes a command can end with: 0 and 2 always; for a generated command, those of the errors it
// documents, and those of signing in, permissions, reaching the server, waiting and confirming; for a hand-written
// one, those its annotation lists.
func exitCodes(d *Command, g *gen.Command, declared string) []int {
	set := map[int]bool{exitcode.OK: true, exitcode.Usage: true}
	if d.Kind == "group" {
		return sorted(set)
	}
	if g != nil {
		set[exitcode.Failed] = true
		for _, e := range d.Errors {
			set[e.ExitCode] = true
		}
		if g.Op != nil {
			set[exitcode.Auth] = true
			set[exitcode.Connection] = true
			set[exitcode.RateLimited] = true
			set[exitcode.Interrupted] = true
			if g.Op.Since != "" {
				set[exitcode.NotSupported] = true
			}
			if g.Op.Permission != nil || g.Op.Interactive {
				set[exitcode.Forbidden] = true
			}
		} else {
			set[exitcode.Auth] = true
			set[exitcode.Connection] = true
			set[exitcode.Interrupted] = true
		}
		if d.LongRunning {
			set[exitcode.Timeout] = true
		}
		if d.Impact == "destructive" || d.Impact == "user-facing" {
			set[exitcode.ActionNeeded] = true
		}
		// A read-only profile, and agent scopes, refuse writes before anything is sent
		if d.Impact != "read" {
			set[exitcode.Forbidden] = true
		}
		return sorted(set)
	}
	for _, s := range strings.Split(declared, ",") {
		var n int
		if _, err := fmt.Sscan(strings.TrimSpace(s), &n); err == nil {
			set[n] = true
		}
	}
	return sorted(set)
}

func sorted(set map[int]bool) []int {
	out := make([]int, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}

// errorCodes fills t.Errors: every code an operation can return, its exit code, the commands that can return it,
// and the hint the CLI gives with it. The hint is worked out by the same code that gives it at run time (gen's
// Hint), for the first command that returns the code and has a get and a list beside it (so the hint shows every
// step it can), with the command's arguments as placeholders.
func errorCodes(root *cobra.Command, f *cmdutil.Factory, m *spec.Manifest, t *Tree) {
	o := spec.MustOverlay()
	byPath := map[string]*cobra.Command{}
	var visit func(*cobra.Command)
	visit = func(c *cobra.Command) {
		for _, s := range c.Commands() {
			byPath[strings.Join(PathOf(s), " ")] = s
			visit(s)
		}
	}
	visit(root)
	best := map[string]int{}
	for _, d := range t.Commands {
		for _, e := range d.Errors {
			ec := t.Errors[e.Code]
			if ec == nil {
				ec = &ErrorCode{Code: e.Code, Status: e.Status, ExitCode: e.ExitCode}
				t.Errors[e.Code] = ec
				best[e.Code] = -1
			}
			ec.Commands = append(ec.Commands, d.Name)
			g := gen.Of(byPath[d.Name])
			if g == nil || g.Op == nil {
				continue
			}
			hint, score := hintFor(f, g, e.Status, e.Code)
			if score > best[e.Code] {
				best[e.Code] = score
				ec.Hint = hint
				ec.HintCommand = d.Name
			}
		}
	}
	for code, ec := range t.Errors {
		sort.Strings(ec.Commands)
		switch {
		case len(o.Next[code]) > 0:
			ec.HintFrom = "overlay"
		case code == "VALIDATION_FAILED":
			ec.HintFrom = "fields"
		case ec.Hint != nil && len(ec.Hint.Next) > 0:
			ec.HintFrom = "exit"
		}
		if ec.Hint != nil && len(ec.Hint.Next) == 0 && len(ec.Hint.Missing) == 0 {
			ec.Hint.Next = nil
		}
	}
}

// hintFor is the hint gen gives a command failing with this code, and how complete it is (a hint for a command
// with a get and a list beside it scores higher).
func hintFor(f *cmdutil.Factory, g *gen.Command, status int, code string) (*cmdutil.Hint, int) {
	args := []string{}
	ids := map[string]string{}
	for _, p := range g.Positionals() {
		if p.File {
			continue
		}
		args = append(args, "<"+strings.TrimSuffix(p.Name, "[@version]")+">")
	}
	r := &gen.Run{F: f, C: g, Cobra: g.Cobra, Args: args, IDs: ids}
	err := r.Hint(&core.APIError{Status: status, Code: code})
	e := cmdutil.FromError(err)
	if e.Hint == nil {
		return nil, 0
	}
	h := &cmdutil.Hint{Missing: e.Hint.Missing, Docs: e.Hint.Docs}
	score := 0
	for _, n := range e.Hint.Next {
		run := unquotePlaceholders(n.Run)
		h.Next = append(h.Next, cmdutil.NextStep{Run: run, Why: n.Why})
		score++
	}
	// Prefer the plainest command for the hint: fewer words reads better in the docs, and a command that uploads a
	// file has an argument the hint can't show
	penalty := len(g.Spec.Path)
	if g.Op.UploadTarget != "" {
		penalty += 50
	}
	return h, score*100 - penalty
}

// unquotePlaceholders turns '<agent>' back into <agent>: a placeholder is not a value to quote.
func unquotePlaceholders(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\'' && i+1 < len(s) && s[i+1] == '<' {
			if j := strings.Index(s[i+1:], ">'"); j > 0 && !strings.ContainsAny(s[i+1:i+1+j], "' ") {
				b.WriteString(s[i+1 : i+2+j])
				i += j + 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// alternatives are the MCP servers, and what each is better at than the CLI (18.3). workspace, when known, fills
// the workspace server's address.
func alternatives(workspace string) Alternatives {
	url := "https://<workspace>/api/mcp"
	if workspace != "" {
		url = "https://" + workspace + "/api/mcp"
	}
	return Alternatives{MCP: MCPAlternatives{
		Workspace: MCPServer{
			Description: "The workspace's management MCP server: typed tools for agents, versions, knowledge bases and conversations, in the AI client's own context.",
			URL:         url,
			Transport:   "streamable-http",
			Auth:        "OAuth: the AI client signs the person in itself; the CLI never hands it a token",
			BetterFor: []string{
				"an AI client with no shell, such as Claude Desktop or a chat app",
				"conversational, multi-step work over one workspace, such as refining an agent's answers from feedback",
			},
			Connect: "caitlyn mcp add <client>",
			Status:  "available where the workspace has turned it on",
		},
		Integrations: MCPServer{
			Description: "The integrations MCP server, installed locally: help writing code against the Caitlyn SDKs.",
			BetterFor: []string{
				"writing code against the SDKs: examples per language, request validation, error explanations",
			},
			Status: "planned",
		},
	}}
}
