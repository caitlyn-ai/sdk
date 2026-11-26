package aisetup

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/describe"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/pager"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// DocsURL is the page that explains setting up AI tools.
const DocsURL = "https://build.caitlyn.ai/cli/ai-agents/#set-up-your-ai-tools"

// Add adds `caitlyn ai` and its commands to the root command.
func Add(r *cobra.Command, f *cmdutil.Factory) {
	group := &cobra.Command{
		Use:   "ai",
		Short: "Set up the AI coding tools in this project (Claude Code, Cursor, Codex, Copilot, Gemini CLI) to work with Caitlyn",
		Args:  cobra.NoArgs,
		RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
	}
	group.AddCommand(newSetupCmd(f), newStatusCmd(f), newRemoveCmd(f))
	r.AddCommand(group)
}

type setupOptions struct {
	tools, with                []string
	dir                        string
	noWorkspace, update, check bool
}

func newSetupCmd(f *cmdutil.Factory) *cobra.Command {
	o := &setupOptions{}
	c := &cobra.Command{
		Use:   "setup",
		Short: "Set up this project's AI coding tools to work with Caitlyn",
		Long: `Finds the AI coding tools this project uses (Claude Code, Cursor, Codex, GitHub Copilot in VS Code and Gemini
CLI) from their files in it, shows what it would write for them, and writes only what you accept:

  instructions   The Caitlyn CLI section, in each tool's own file: AGENTS.md (Codex, Cursor), CLAUDE.md (Claude Code,
                 as one @AGENTS.md line when AGENTS.md has the section), .github/copilot-instructions.md, GEMINI.md
  skill          The CLI's skill for Claude Code, .claude/skills/caitlyn/, made from the CLI you have installed
  mcp            The workspace's MCP server, in .mcp.json, .cursor/mcp.json and .vscode/mcp.json
  defaults       .caitlyn.toml naming this project's workspace (not chosen unless you choose it)

Nothing is written until you agree to the plan; --dry-run only shows it, with every change as a diff in JSON.
Running it again changes nothing that is already right. No credentials go into any file: each tool signs in to
the workspace itself. Every file it writes is marked, so caitlyn ai status reports it and caitlyn ai remove takes it
out again, even in a copy of the repository someone else cloned.

The files name the workspace. For a public repository, --no-workspace leaves it out (and the MCP server and
project defaults with it).

--update regenerates what is already set up, and adds nothing; --check says whether any of it is out of date for
this version of the CLI, and exits 3 if it is, for CI.

An AI tool may run it: it never asks, prints the plan as JSON, and writes only with --yes, once the person has
seen the plan, because these files tell AI tools how to behave. It never changes agent scopes.`,
		Example: `  caitlyn ai setup
  # Only show the plan, for these tools
  caitlyn ai setup --tools claude-code,cursor --with instructions,skill,mcp --dry-run
  # In CI: fail when the committed files are out of date
  caitlyn ai setup --check`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSetup(cmd, f, o, nil)
		},
	}
	fl := c.Flags()
	fl.StringSliceVar(&o.tools, "tools", nil, "The tools to set up, separated by commas: "+strings.Join(ToolNames(), ", ")+" (default: the ones this project uses)")
	fl.StringSliceVar(&o.with, "with", nil, "What to set up, separated by commas: instructions, skill, mcp, defaults (default: all but defaults)")
	fl.StringVar(&o.dir, "dir", "", "The project folder (default: the repository the working folder is in)")
	fl.BoolVar(&o.noWorkspace, "no-workspace", false, "Leave the workspace's name out of the files, for a public repository")
	fl.BoolVar(&o.update, "update", false, "Regenerate what is already set up, and add nothing")
	fl.BoolVar(&o.check, "check", false, "Say whether what is set up is out of date for this CLI, and exit 3 if it is")
	_ = c.RegisterFlagCompletionFunc("tools", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return ToolNames(), cobra.ShellCompDirectiveNoFileComp
	})
	_ = c.RegisterFlagCompletionFunc("with", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return Offers, cobra.ShellCompDirectiveNoFileComp
	})
	return describe.Annotate(c, "write", "3,5")
}

func newStatusCmd(f *cmdutil.Factory) *cobra.Command {
	var dir string
	c := &cobra.Command{
		Use:   "status",
		Short: "What ai setup made in this project, and whether it is out of date",
		Long: `Lists what caitlyn ai setup made in this project, from the marks it leaves in each file: the instructions
sections, Claude Code's import of AGENTS.md, the skill and the MCP server's entries, with the CLI version and
workspace each was made for, and whether it is out of date (made by another version, for another workspace) or was
edited by hand. It also shows which AI tools the project uses, and what the profile lets AI tools do.`,
		Example: "  caitlyn ai status\n  caitlyn ai status --output json",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runStatus(cmd, f, dir)
		},
	}
	c.Flags().StringVar(&dir, "dir", "", "The project folder (default: the repository the working folder is in)")
	return describe.Annotate(c, "read", "")
}

func newRemoveCmd(f *cmdutil.Factory) *cobra.Command {
	var tools, with []string
	var dir string
	c := &cobra.Command{
		Use:   "remove",
		Short: "Take out what ai setup made, keeping everything else",
		Long: `Takes out what caitlyn ai setup made, found by the marks it leaves: its section in each instructions file, its
@AGENTS.md line in CLAUDE.md, the skill, and the caitlyn server in each MCP file. Everything else in those files
stays as it was, and a file left with nothing in it is deleted. A skill edited by hand since setup wrote it is
only removed once you agree. .caitlyn.toml is configuration rather than something setup owns, so it stays:
caitlyn config unset workspace --project removes its workspace.

--tools takes out only what those tools use; AGENTS.md, which Cursor and Codex both read, goes when both are named.
Like setup, it shows the plan and asks first, and under an AI tool it needs --yes.`,
		Example: "  caitlyn ai remove --dry-run\n  caitlyn ai remove --tools cursor,codex",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRemove(cmd, f, dir, tools, with)
		},
	}
	c.Flags().StringSliceVar(&tools, "tools", nil, "Only what these tools use, separated by commas: "+strings.Join(ToolNames(), ", "))
	c.Flags().StringSliceVar(&with, "with", nil, "Only these, separated by commas: instructions, skill, mcp")
	c.Flags().StringVar(&dir, "dir", "", "The project folder (default: the repository the working folder is in)")
	_ = c.RegisterFlagCompletionFunc("tools", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return ToolNames(), cobra.ShellCompDirectiveNoFileComp
	})
	return describe.Annotate(c, "write", "3")
}

// project is what every ai command works out first: the project, the workspace and profile, and the tools found.
type project struct {
	root, home  string
	workspace   string
	profile     string
	agentScopes []string
	defaults    map[string]string
	detected    []Detection
	inProject   bool
	tree        func() *describe.Tree
	version     string
}

// signIn is what sign-in hands the offer: the workspace and profile it just saved, which the loaded configuration
// doesn't have yet.
type signIn struct {
	workspace, profile string
	agentScopes        []string
	// pr is the prompter sign-in asked with, which has read ahead of the next answers
	pr prompt.Prompter
}

func newContext(cmd *cobra.Command, f *cmdutil.Factory, dir string, s *signIn) (*project, error) {
	cfg, err := f.Config()
	if err != nil {
		return nil, err
	}
	home := f.Home
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	work := f.WorkDir
	if work == "" {
		work, _ = os.Getwd()
	}
	x := &project{home: home, version: f.Version, defaults: map[string]string{}}
	if dir != "" {
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(work, dir)
		}
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			return nil, cmdutil.Usagef("%s is not a folder.", dir)
		}
		x.root, x.inProject = filepath.Clean(dir), true
	} else {
		x.root, x.inProject = ProjectRoot(work, home)
	}
	x.workspace = cfg.String("workspace")
	x.profile = cfg.Profile()
	v := cfg.Get("agent_scopes")
	x.agentScopes = v.List
	if len(x.agentScopes) == 0 && v.Value != "" {
		x.agentScopes = []string{v.Value}
	}
	if s != nil {
		x.workspace, x.profile = s.workspace, s.profile
		if s.agentScopes != nil {
			x.agentScopes = s.agentScopes
		}
	}
	// the profile's own defaults, never a flag's or the environment's
	for _, k := range []string{"agent", "knowledge_base"} {
		if v := cfg.Get(k); v.Origin == config.FromProfile || v.Origin == config.FromProject {
			x.defaults[k] = v.Value
		}
	}
	x.detected = Detect(x.root, Env{Home: home, Getenv: f.IO.Getenv, Agent: f.Agent.Name})
	root := cmd.Root()
	var t *describe.Tree
	x.tree = func() *describe.Tree {
		if t == nil {
			t = describe.Build(root, f, describe.Options{})
		}
		return t
	}
	return x, nil
}

// asData reports whether the output is for a program: JSON, YAML, or a query.
func asData(f *cmdutil.Factory) bool {
	format, _ := output.Resolve(f)
	return format == output.JSON || format == output.JSONL || format == output.YAML || f.Globals.JQ != "" || f.Globals.Query != ""
}

func parseTools(names []string) ([]*Tool, error) {
	var out []*Tool
	seen := map[string]bool{}
	for _, n := range names {
		if n = strings.TrimSpace(n); n == "" {
			continue
		}
		t := FindTool(n)
		if t == nil {
			e := cmdutil.Usagef("%q is not a tool caitlyn ai knows: use %s.", n, strings.Join(ToolNames(), ", "))
			e.Detail = "For another tool that reads AGENTS.md, set up codex: it writes the same file."
			return nil, e
		}
		if !seen[t.Name] {
			seen[t.Name] = true
			out = append(out, t)
		}
	}
	return out, nil
}

func parseWith(names []string, allowed []string) (map[string]bool, error) {
	out := map[string]bool{}
	for _, n := range names {
		n = strings.ToLower(strings.TrimSpace(n))
		if n == "" {
			continue
		}
		ok := false
		for _, a := range allowed {
			ok = ok || a == n
		}
		if !ok {
			return nil, cmdutil.Usagef("--with takes %s, not %q.", strings.Join(allowed, ", "), n)
		}
		out[n] = true
	}
	return out, nil
}

// view is a plan as JSON: the plan, and what it was made from.
type view struct {
	DryRun  bool `json:"dryRun"`
	Written bool `json:"written"`
	*Plan
	Version     string      `json:"version"`
	Profile     string      `json:"profile,omitempty"`
	AgentScopes string      `json:"agentScopes"`
	Detected    []Detection `json:"detected"`
}

func (x *project) view(p *Plan) *view {
	d := x.detected
	if d == nil {
		d = []Detection{}
	}
	return &view{Plan: p, Version: describe.NewStamp(x.version, "").Version, Profile: x.profile, AgentScopes: agent.Describe(x.agentScopes), Detected: d}
}

func runSetup(cmd *cobra.Command, f *cmdutil.Factory, o *setupOptions, s *signIn) error {
	if (o.update || o.check) && (len(o.tools) > 0 || len(o.with) > 0) {
		return cmdutil.Usagef("--update and --check work on what is already set up, so they take no --tools or --with.")
	}
	x, err := newContext(cmd, f, o.dir, s)
	if err != nil {
		return err
	}
	req := &Request{Root: x.root, Version: x.version, Current: x.workspace, NoWorkspace: o.noWorkspace, Defaults: x.defaults, Tree: x.tree}
	if !o.noWorkspace {
		req.Workspace = x.workspace
	}
	if o.check {
		return runCheck(f, x, req)
	}
	u := gen.UIFor(f)
	data := asData(f)
	var pr prompt.Prompter
	if !f.Agent.On {
		pr, _ = prompt.For(f.IO)
	}
	if s != nil && s.pr != nil {
		pr = s.pr
	}
	if o.update {
		p, err := PlanUpdate(req)
		if err != nil {
			return err
		}
		return apply(cmd, f, u, x, p, pr, data, "update")
	}
	// The tools: as named, or those the project's files show (and the AI tool running this), asking about the ones
	// only this machine suggests
	if len(o.tools) > 0 {
		if req.Tools, err = parseTools(o.tools); err != nil {
			return err
		}
	} else {
		var hinted bool
		for _, d := range x.detected {
			if d.Selected() {
				req.Tools = append(req.Tools, d.Tool)
			} else {
				hinted = true
			}
		}
		if !data {
			header(f.IO.Out, u, x)
		}
		if hinted && pr != nil && !data && !f.Globals.Yes {
			if req.Tools, err = askTools(pr, x.detected); err != nil {
				return err
			}
		}
	}
	if len(o.tools) > 0 && !data {
		header(f.IO.Out, u, x)
	}
	if len(o.with) > 0 {
		if req.With, err = parseWith(o.with, Offers); err != nil {
			return err
		}
	} else {
		req.With = defaultOffers(req)
		if pr != nil && !data && !f.Globals.Yes {
			if req.With, err = askOffers(pr, req); err != nil {
				return err
			}
		}
	}
	if req.With[WithDefaults] && f.Agent.On {
		e := cmdutil.Forbiddenf("AGENT_NOT_ALLOWED", "Only a person can choose this project's workspace in .caitlyn.toml.")
		e.Detail = "The project file's workspace decides where commands run here send the person's credentials, so an AI tool may not set it."
		e.AddNext(setupLine(req, nil)+" --with "+strings.Join(withoutDefaults(req.With), ","), "set up the rest")
		return e
	}
	p, err := PlanSetup(req)
	if err != nil {
		return err
	}
	return apply(cmd, f, u, x, p, pr, data, "setup")
}

func withoutDefaults(with map[string]bool) []string {
	var out []string
	for _, w := range Offers {
		if with[w] && w != WithDefaults {
			out = append(out, w)
		}
	}
	return out
}

// defaultOffers are what is ticked when nobody chooses: the instructions, the skill when Claude Code is set up, and
// the MCP server for the tools that take it; never the project defaults.
func defaultOffers(r *Request) map[string]bool {
	with := map[string]bool{WithInstructions: true}
	for _, t := range r.Tools {
		if t.Skill {
			with[WithSkill] = true
		}
		if t.MCP != "" {
			// without a workspace, the plan says why it is left out
			with[WithMCP] = true
		}
	}
	return with
}

func askTools(pr prompt.Prompter, detected []Detection) ([]*Tool, error) {
	var opts []prompt.Option
	var sel []int
	for i, d := range detected {
		why := strings.Join(d.Markers, ", ")
		if why == "" {
			why = strings.Join(d.Hints, ", ")
		}
		opts = append(opts, prompt.Option{Label: d.Label, Description: why, Value: d.Name})
		if d.Selected() {
			sel = append(sel, i)
		}
	}
	idx, err := pr.MultiSelect("Which tools do you use in this project?", opts, sel)
	if err != nil {
		return nil, err
	}
	var out []*Tool
	for _, i := range idx {
		out = append(out, detected[i].Tool)
	}
	return out, nil
}

func askOffers(pr prompt.Prompter, r *Request) (map[string]bool, error) {
	def := defaultOffers(r)
	type offer struct{ value, label, files string }
	instr := map[string]bool{}
	var mcp []string
	agents := len(r.Tools) == 0
	for _, t := range r.Tools {
		if t.Instructions == agentsMD {
			agents = true
		}
	}
	if agents {
		instr[agentsMD] = true
	}
	for _, t := range r.Tools {
		instr[t.Instructions] = true
		if t.MCP != "" {
			mcp = append(mcp, mcpFile(t.MCP))
		}
	}
	var files []string
	for _, f := range instructionFiles {
		if instr[f] {
			files = append(files, f)
		}
	}
	offers := []offer{{WithInstructions, "Instructions: how to use the caitlyn CLI safely", strings.Join(files, ", ")}}
	for _, t := range r.Tools {
		if t.Skill {
			offers = append(offers, offer{WithSkill, "Claude Code skill: workflows and every command", skillDir + "/"})
			break
		}
	}
	if len(mcp) > 0 && r.Workspace != "" {
		offers = append(offers, offer{WithMCP, "Workspace MCP server: ask about your workspace in chat", strings.Join(mcp, ", ")})
	}
	if r.Workspace != "" {
		offers = append(offers, offer{WithDefaults, "Project defaults: this project uses " + r.Workspace, projectFile})
	}
	var opts []prompt.Option
	var sel []int
	for i, o := range offers {
		opts = append(opts, prompt.Option{Label: o.label, Description: o.files, Value: o.value})
		if def[o.value] {
			sel = append(sel, i)
		}
	}
	idx, err := pr.MultiSelect("What should they get?", opts, sel)
	if err != nil {
		return nil, err
	}
	with := map[string]bool{}
	for _, i := range idx {
		with[offers[i].value] = true
	}
	return with, nil
}

// header is what the plan is for: the project, the tools found, the workspace and what the profile lets AI tools do.
func header(w io.Writer, u *ui.UI, x *project) {
	fmt.Fprintf(w, "%s\n\n", u.S(ui.Strong, "AI coding tools in "+tilde(x.root, x.home)))
	var found []string
	for _, d := range x.detected {
		if !d.Selected() {
			continue
		}
		s := d.Label
		if len(d.Markers) > 0 {
			s += " (" + strings.Join(d.Markers, ", ") + ")"
		}
		found = append(found, s)
	}
	if len(found) == 0 {
		found = []string{u.S(ui.Muted, "none in this project's files, so AGENTS.md, which most tools read")}
	}
	fmt.Fprintf(w, "  %-10s %s\n", "Detected", strings.Join(found, "   "))
	if x.workspace != "" {
		fmt.Fprintf(w, "  %-10s %s %s profile %s\n", "Workspace", x.workspace, u.G.Dot, x.profile)
	} else {
		fmt.Fprintf(w, "  %-10s %s\n", "Workspace", u.S(ui.Muted, "none chosen yet (caitlyn auth login): the files won't name one"))
	}
	fmt.Fprintf(w, "  AI tools may: %s (agent_scopes). %s\n\n", agent.Describe(x.agentScopes),
		u.S(ui.Muted, "Change: caitlyn config set agent_scopes "+u.G.Ellipsis+" --profile "+x.profile))
}

// tilde shows a folder under the home folder as ~/…
func tilde(dir, home string) string {
	if home != "" {
		if r, err := filepath.Rel(home, dir); err == nil && !strings.HasPrefix(r, "..") {
			if r == "." {
				return "~"
			}
			return "~/" + filepath.ToSlash(r)
		}
	}
	return dir
}

// renderPlan lists the plan's changes, one line a file, and what was left out.
func renderPlan(w io.Writer, u *ui.UI, p *Plan, title string) {
	if title != "" {
		fmt.Fprintf(w, "%s\n\n", u.S(ui.Strong, title))
	}
	width := 0
	for _, c := range p.Changes {
		width = max(width, len(c.File))
	}
	for _, c := range p.Changes {
		counts := ""
		switch {
		case c.Action == "delete":
			counts = fmt.Sprintf("- %d %s", c.Removed, plural(c.Removed, "line", "lines"))
		case c.Removed == 0:
			counts = fmt.Sprintf("+ %d %s", c.Added, plural(c.Added, "line", "lines"))
		case c.Added == 0:
			counts = fmt.Sprintf("- %d %s", c.Removed, plural(c.Removed, "line", "lines"))
		default:
			counts = fmt.Sprintf("+%d -%d lines", c.Added, c.Removed)
		}
		role := ui.Changed
		switch c.Action {
		case "create":
			role = ui.Added
		case "delete":
			role = ui.Removed
		}
		line := fmt.Sprintf("  %s  %-*s  %-12s", u.S(role, fmt.Sprintf("%-6s", c.Action)), width, c.File, counts)
		if c.Summary != "" {
			line += "  " + u.S(ui.Muted, "("+c.Summary+")")
		}
		if c.Edited {
			line += "  " + u.S(ui.Warning, "edited by hand")
		}
		fmt.Fprintln(w, strings.TrimRight(line, " "))
	}
	for _, s := range p.Skipped {
		if s.Why == SkipNotSupported {
			continue // the tool simply doesn't take it yet
		}
		what := s.What
		if s.File != "" {
			what = s.File
		}
		fmt.Fprintf(w, "  %s  %s\n", u.S(ui.Muted, "skip  "), u.S(ui.Muted, what+": "+s.Detail))
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// setupLine is the command line that makes the same plan again, for hints.
func setupLine(r *Request, p *Plan) string {
	line := "caitlyn ai setup"
	tools, with := []string{}, []string{}
	if p != nil {
		tools, with = p.Tools, p.With
	} else {
		for _, t := range r.Tools {
			tools = append(tools, t.Name)
		}
	}
	if len(tools) > 0 {
		line += " --tools " + strings.Join(tools, ",")
	}
	if len(with) > 0 {
		line += " --with " + strings.Join(with, ",")
	}
	if r != nil && r.NoWorkspace {
		line += " --no-workspace"
	}
	return line
}

// apply shows the plan, asks (or, under an AI tool, needs --yes), and writes it. kind is setup, update or remove.
func apply(cmd *cobra.Command, f *cmdutil.Factory, u *ui.UI, x *project, p *Plan, pr prompt.Prompter, data bool, kind string) error {
	dry := f.Globals.DryRun != ""
	v := x.view(p)
	line := "caitlyn ai " + kind
	switch kind {
	case "setup":
		line = setupLine(&Request{NoWorkspace: cmd.Flags().Changed("no-workspace")}, p)
	case "update":
		line = "caitlyn ai setup --update"
	case "remove":
		if len(p.Tools) > 0 {
			line += " --tools " + strings.Join(p.Tools, ",")
		}
	}
	nothing := map[string]string{
		"setup":  "Everything is already set up. Nothing changed.",
		"update": "Everything caitlyn ai setup made here is up to date. Nothing changed.",
		"remove": "Nothing here was made by caitlyn ai setup. Nothing changed.",
	}[kind]
	if kind == "update" && len(p.With) == 0 {
		nothing = "Nothing here was made by caitlyn ai setup, so there is nothing to update. Set your AI tools up: caitlyn ai setup"
	}
	if !data {
		if len(p.Changes) == 0 {
			renderPlan(f.IO.Out, u, p, "")
			fmt.Fprintln(f.IO.Out, nothing)
			return nil
		}
		title := "Plan (nothing written yet)"
		if dry {
			title = ""
		}
		renderPlan(f.IO.Out, u, p, title)
		if kind != "remove" && p.Workspace != "" && contains(p.With, WithMCP) {
			fmt.Fprintf(f.IO.Out, "\n  %s\n", u.S(ui.Muted, "No credentials are written. Each tool signs in to "+p.Workspace+" itself the first time it connects."))
		}
	}
	if len(p.Changes) == 0 {
		return describe.Print(f, v)
	}
	if dry {
		v.DryRun = true
		if data {
			return describe.Print(f, v)
		}
		fmt.Fprintln(f.IO.Out, "Dry run: nothing was written. Run again without --dry-run to write these files.")
		return nil
	}
	if f.Agent.On && !f.Globals.Yes {
		// The files tell AI tools how to behave: the person sees the plan before an AI tool writes it
		if data {
			_ = describe.Print(f, v)
		}
		n := len(p.Changes)
		e := cmdutil.ActionNeeded(fmt.Sprintf("ai %s would change %d %s that tell AI tools how to behave. Show the person the plan first.", kind, n, plural(n, "file", "files")), "--yes")
		e.Detail = "Nothing was written. Under an AI tool, caitlyn ai " + kind + " writes only with --yes, once the person has seen the plan and agreed."
		e.Hint.Docs = DocsURL
		e.AddNext(line+" --dry-run", "see the plan and show it to the person")
		e.AddNext(line+" --yes", "write it, once the person agrees")
		return e
	}
	// A file edited by hand is replaced or removed only when a person says so: --yes from a person, or at a terminal
	for _, group := range editedGroups(p) {
		files := []string{}
		for _, c := range p.Changes {
			if c.group == group {
				files = append(files, c.File)
			}
		}
		if f.Globals.Yes && !f.Agent.On {
			continue
		}
		if pr == nil {
			p.drop(group, SkipEdited, "it was changed by hand since caitlyn ai setup wrote it, so it was kept: run "+line+" at a terminal to choose")
			continue
		}
		verb := "Replace"
		if kind == "remove" {
			verb = "Remove"
		}
		ok, err := pr.Confirm(fmt.Sprintf("%s was changed by hand since caitlyn ai setup wrote it. %s it anyway?", files[0], verb), false)
		if err != nil {
			return err
		}
		if !ok {
			p.drop(group, SkipEdited, "kept: it was changed by hand")
		}
	}
	if len(p.Changes) == 0 {
		if data {
			return describe.Print(f, v)
		}
		fmt.Fprintln(f.IO.Out, "Nothing changed.")
		return nil
	}
	if !f.Globals.Yes && !f.Agent.On {
		switch {
		case pr != nil:
			ok, err := confirm(f, u, p, pr, kind)
			if err != nil {
				return err
			}
			if !ok {
				return cmdutil.Silent(exitcode.ActionNeeded)
			}
		case f.Globals.NoInput:
			return cmdutil.ActionNeeded(fmt.Sprintf("caitlyn ai %s needs a confirmation, and --no-input means nobody may be asked: add --yes to write the plan.", kind), "--yes")
		}
	}
	for _, c := range p.Changes {
		if err := c.file.Write(); err != nil {
			return err
		}
	}
	v.Written = true
	if data {
		return describe.Print(f, v)
	}
	done(f, u, p, kind)
	return nil
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func editedGroups(p *Plan) []string {
	var out []string
	seen := map[string]bool{}
	for _, c := range p.Changes {
		if c.Edited && !seen[c.group] {
			seen[c.group] = true
			out = append(out, c.group)
		}
	}
	return out
}

// confirm asks whether to write the plan, showing every change in full (through the pager) when asked.
func confirm(f *cmdutil.Factory, u *ui.UI, p *Plan, pr prompt.Prompter, kind string) (bool, error) {
	n := len(p.Changes)
	q := fmt.Sprintf("Write %s?", plural(n, "this file", fmt.Sprintf("these %d files", n)))
	if kind == "remove" {
		q = fmt.Sprintf("Change %s?", plural(n, "this file", fmt.Sprintf("these %d files", n)))
	}
	fmt.Fprintln(f.IO.ErrOut)
	for {
		i, err := pr.Select(q, []prompt.Option{{Label: "Yes", Value: "yes"}, {Label: "Show the changes in full", Value: "show"}, {Label: "No", Value: "no"}}, 0)
		if err != nil {
			return false, err
		}
		switch i {
		case 0:
			return true, nil
		case 1:
			var b strings.Builder
			for _, c := range p.Changes {
				describe.RenderDiff(&b, u, c.Diff)
				b.WriteString("\n")
			}
			if err := pager.Page(f, b.String()); err != nil {
				return false, err
			}
		default:
			fmt.Fprintln(f.IO.ErrOut, "Nothing was written.")
			return false, nil
		}
	}
}

// done says what was written, and what to do next.
func done(f *cmdutil.Factory, u *ui.UI, p *Plan, kind string) {
	n := len(p.Changes)
	files := fmt.Sprintf("%d %s", n, plural(n, "file", "files"))
	switch kind {
	case "remove":
		u.Successf("Took Caitlyn out of %s. Everything else in them was kept.", files)
		return
	case "update":
		u.Successf("Updated %s.", files)
	default:
		u.Successf("Wrote %s. Every Caitlyn section is marked, so you can undo it: caitlyn ai remove", files)
	}
	u.Infof("  Commit them to share with your team, or add them to .gitignore to keep them to yourself.")
	for _, c := range p.Changes {
		if c.File == ".mcp.json" && c.What == WithMCP {
			u.Infof("  Claude Code asks you to approve the %s server the first time it starts here.", describe.MCPServerName)
		}
	}
	u.Infof("  Check any time: caitlyn ai status")
}

// StatusItem is one thing setup made, as caitlyn ai status reports it.
type StatusItem struct {
	File      string   `json:"file"`
	What      string   `json:"what"`
	Tools     []string `json:"tools"`
	Version   string   `json:"version,omitempty"`
	Workspace string   `json:"workspace,omitempty"`
	// State is up-to-date, out-of-date or edited (changed by hand, and kept by --update unless a person agrees).
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type statusView struct {
	Root        string       `json:"root"`
	Version     string       `json:"version"`
	Workspace   string       `json:"workspace,omitempty"`
	Profile     string       `json:"profile,omitempty"`
	AgentScopes string       `json:"agentScopes"`
	Detected    []Detection  `json:"detected"`
	Items       []StatusItem `json:"items"`
	UpToDate    bool         `json:"upToDate"`
}

// status works out each thing setup made and whether it is out of date: made by another version, for another
// workspace, or not what this version would write.
func status(x *project, req *Request) (*statusView, error) {
	items, err := inventory(x.root)
	if err != nil {
		return nil, err
	}
	update, err := PlanUpdate(req)
	if err != nil {
		return nil, err
	}
	version := describe.NewStamp(x.version, "").Version
	sv := &statusView{Root: x.root, Version: version, Workspace: x.workspace, Profile: x.profile, AgentScopes: agent.Describe(x.agentScopes),
		Detected: x.detected, Items: []StatusItem{}, UpToDate: true}
	if sv.Detected == nil {
		sv.Detected = []Detection{}
	}
	changed := map[string]bool{}
	for _, c := range update.Changes {
		changed[c.File] = true
	}
	for _, it := range items {
		s := StatusItem{File: it.rel, What: it.what, Tools: it.tools, State: "up-to-date"}
		if s.Tools == nil {
			s.Tools = []string{}
		}
		switch it.what {
		case WithInstructions, WithSkill:
			s.Version, s.Workspace = it.stamp.Version, it.stamp.Workspace
			want := req.updateWorkspace(it.stamp.Workspace)
			switch {
			case it.stamp.Version != version:
				s.State, s.Reason = "out-of-date", fmt.Sprintf("made by caitlyn %s; this is %s", it.stamp.Version, version)
			case it.stamp.Workspace != want:
				s.State, s.Reason = "out-of-date", fmt.Sprintf("made for %s; the profile's workspace is %s", orNone(it.stamp.Workspace), orNone(want))
			case it.edited:
				s.State, s.Reason = "edited", "changed by hand since caitlyn ai setup wrote it"
			case changed[it.rel]:
				s.State, s.Reason = "out-of-date", "not what this version writes"
			}
		case WithMCP:
			s.Workspace = it.workspace
			if x.workspace != "" && !req.NoWorkspace && it.workspace != x.workspace {
				s.State, s.Reason = "out-of-date", fmt.Sprintf("connects %s; the profile's workspace is %s", it.workspace, x.workspace)
			} else if changed[it.rel] {
				s.State, s.Reason = "out-of-date", "not what this version writes"
			}
		case WithDefaults:
			s.Workspace = it.workspace
		}
		if s.State == "out-of-date" {
			sv.UpToDate = false
		}
		sv.Items = append(sv.Items, s)
	}
	return sv, nil
}

func orNone(ws string) string {
	if ws == "" {
		return "no workspace"
	}
	return ws
}

func runStatus(cmd *cobra.Command, f *cmdutil.Factory, dir string) error {
	x, err := newContext(cmd, f, dir, nil)
	if err != nil {
		return err
	}
	req := &Request{Root: x.root, Version: x.version, Workspace: x.workspace, Current: x.workspace, Tree: x.tree}
	sv, err := status(x, req)
	if err != nil {
		return err
	}
	if asData(f) {
		return describe.Print(f, sv)
	}
	u := gen.UIFor(f)
	header(f.IO.Out, u, x)
	if len(sv.Items) == 0 {
		fmt.Fprintln(f.IO.Out, "Nothing here was made by caitlyn ai setup.")
		u.Nextf("Set your AI tools up: caitlyn ai setup")
		return nil
	}
	rows := make([][]ui.Cell, 0, len(sv.Items))
	for _, s := range sv.Items {
		role := ui.Success
		state := strings.ReplaceAll(s.State, "-", " ")
		switch s.State {
		case "out-of-date":
			role = ui.Warning
		case "edited":
			role = ui.Changed
		}
		if s.Reason != "" {
			state += ": " + s.Reason
		}
		rows = append(rows, []ui.Cell{{Text: s.File, Keep: true}, {Text: s.What}, {Text: strings.Join(s.Tools, ", ")}, {Text: s.Version}, {Text: s.Workspace}, {Text: state, Role: role}})
	}
	u.Table(f.IO.Out, f.IO.IsStdoutTTY(), []string{"File", "What", "Tools", "Made by", "Workspace", "State"}, rows, "")
	if !sv.UpToDate {
		u.Nextf("Bring them up to date: caitlyn ai setup --update")
	}
	return nil
}

// runCheck is setup --check: the status of what is set up, and exit 3 when any of it is out of date (for CI).
func runCheck(f *cmdutil.Factory, x *project, req *Request) error {
	sv, err := status(x, req)
	if err != nil {
		return err
	}
	stale := 0
	for _, s := range sv.Items {
		if s.State == "out-of-date" {
			stale++
		}
	}
	if asData(f) {
		if err := describe.Print(f, sv); err != nil {
			return err
		}
	} else {
		width := 0
		for _, s := range sv.Items {
			width = max(width, len(s.File))
		}
		for _, s := range sv.Items {
			state := strings.ReplaceAll(s.State, "-", " ")
			if s.Reason != "" && s.State == "out-of-date" {
				state = s.Reason
			} else if s.Reason != "" {
				state += ": " + s.Reason
			}
			fmt.Fprintf(f.IO.Out, "%-*s  %s\n", width, s.File, state)
		}
		if len(sv.Items) == 0 {
			fmt.Fprintln(f.IO.Out, "Nothing here was made by caitlyn ai setup, so nothing is out of date.")
		}
	}
	if stale == 0 {
		return nil
	}
	e := &cmdutil.Error{Exit: exitcode.ActionNeeded, Code: "AI_SETUP_OUT_OF_DATE",
		Title:  fmt.Sprintf("%d %s out of date.", stale, plural(stale, "file is", "files are")),
		Detail: "Run caitlyn ai setup --update locally and commit the result."}
	e.Hint = &cmdutil.Hint{Docs: DocsURL}
	e.AddNext("caitlyn ai setup --update", "regenerate what is set up, for this version of the CLI")
	return e
}

func runRemove(cmd *cobra.Command, f *cmdutil.Factory, dir string, tools, with []string) error {
	x, err := newContext(cmd, f, dir, nil)
	if err != nil {
		return err
	}
	req := &Request{Root: x.root, Version: x.version}
	if req.Tools, err = parseTools(tools); err != nil {
		return err
	}
	if req.With, err = parseWith(with, []string{WithInstructions, WithSkill, WithMCP}); err != nil {
		return err
	}
	p, err := PlanRemove(req)
	if err != nil {
		return err
	}
	var pr prompt.Prompter
	if !f.Agent.On {
		pr, _ = prompt.For(f.IO)
	}
	return apply(cmd, f, gen.UIFor(f), x, p, pr, asData(f), "remove")
}
