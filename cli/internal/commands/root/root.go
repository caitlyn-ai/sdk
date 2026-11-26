// Package root is the `caitlyn` command: global flags, the generated command tree, the hand-written commands, and
// how a run ends (errors on stderr, the exit code, your own traces, usage data for Caitlyn and the update notice).
package root

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/traces"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// Version is the CLI's version: the manifest's (the SDKs' version), unless the release build sets it with -ldflags.
var Version = ""

// Extension points other packages fill in at init, so this package needs no import of them.
var (
	// AddCommands adds the hand-written commands (auth, config, chat, kb sync, api, …).
	AddCommands []func(root *cobra.Command, f *cmdutil.Factory)
	// BeforeRun runs after the global flags are parsed and before the command (the first-run notice, usage data for Caitlyn).
	BeforeRun []func(f *cmdutil.Factory, cmd *cobra.Command)
	// AfterRun runs after the command, with its exit code (usage data for Caitlyn, the update notice).
	AfterRun []func(f *cmdutil.Factory, cmd *cobra.Command, code int, took time.Duration)
	// Welcome draws `caitlyn` with no arguments.
	Welcome = func(f *cmdutil.Factory, u *ui.UI, cmd *cobra.Command) error { return cmd.Help() }
	// NewAuth makes the sign-in provider.
	NewAuth = func() cmdutil.AuthProvider { return envAuth{} }
	// UISettings adds what the ui package needs from elsewhere (the background query).
	UISettings = func(f *cmdutil.Factory, s *ui.Settings) {}
)

// Main runs the CLI with the process's streams and returns the exit code.
func Main(args []string) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return Run(ctx, iostreams.System(), args, nil)
}

// Run runs the CLI. setup, when given, adjusts the factory before the command runs (tests).
func Run(ctx context.Context, io *iostreams.IOStreams, args []string, setup func(*cmdutil.Factory)) int {
	if Version == "" {
		if m, err := spec.Load(); err == nil {
			Version = m.Version
		}
	}
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Version: Version, Now: time.Now, Auth: NewAuth()}
	f.Agent = agent.Detect(agent.Env{Lookup: io.LookupEnv, StdinTTY: io.IsStdinTTY()})
	f.CI = ci.Detect(io.LookupEnv)
	if setup != nil {
		setup(f)
	}
	u := ui.New(io)
	gen.UIFor = func(*cmdutil.Factory) *ui.UI { return u }
	cmd, err := New(f, &u)
	if err != nil {
		fmt.Fprintln(io.ErrOut, "caitlyn:", err)
		return exitcode.Failed
	}
	cmd.SetArgs(helpArgs(cmd, args))
	cmd.SetIn(io.In)
	cmd.SetOut(io.Out)
	cmd.SetErr(io.ErrOut)
	start := time.Now()
	executed, err := cmd.ExecuteContextC(ctx)
	if executed == nil {
		executed = cmd
	}
	code := exitcode.OK
	if err != nil {
		e := classify(err, ctx, executed)
		code = e.Exit
		if !e.Silent {
			report(f, u, e, executed)
		}
	}
	// Your own traces: close the root span, named after the command, and flush (a second at most)
	f.Traces.End(strings.TrimSpace(strings.TrimPrefix(executed.CommandPath(), "caitlyn")), code)
	for _, h := range AfterRun {
		h(f, executed, code, time.Since(start))
	}
	return code
}

// classify turns cobra's and everyone else's errors into *cmdutil.Error with an exit code. cmd is the command cobra
// reached: for an unknown command, the group it was looked for in.
func classify(err error, ctx context.Context, cmd *cobra.Command) *cmdutil.Error {
	var ce *cmdutil.Error
	if errors.As(err, &ce) {
		return ce
	}
	if ctx.Err() != nil {
		return &cmdutil.Error{Exit: exitcode.Interrupted, Title: "Interrupted.", Code: "INTERRUPTED"}
	}
	msg := err.Error()
	for _, p := range []string{"unknown command", "unknown flag", "unknown shorthand flag", "flag needs an argument", "invalid argument", "accepts ", "requires at least", "accepts at most", "required flag"} {
		if strings.Contains(msg, p) {
			e := cmdutil.Usagef("%s", strings.TrimSuffix(msg, "\n"))
			if strings.Contains(msg, "unknown command") {
				e.AddNext("caitlyn commands --output json", "list every command")
				e.Human = unknownCommand(msg, cmd)
			}
			return e
		}
	}
	return cmdutil.FromError(err)
}

// unknownCommand is the human form of cobra's "unknown command" error: the command cobra reached and the word it
// didn't know, the commands it suggests, and `<group> help` to see the group's commands.
func unknownCommand(msg string, cmd *cobra.Command) *cmdutil.HumanForm {
	lines := strings.Split(strings.TrimSpace(msg), "\n")
	word, _, _ := strings.Cut(strings.TrimPrefix(lines[0], "unknown command "), " for ")
	path := "caitlyn"
	if cmd != nil {
		path = cmd.CommandPath()
	}
	h := &cmdutil.HumanForm{Title: fmt.Sprintf("%s: unknown command %s", path, word)}
	var near []string
	for _, l := range lines[1:] {
		if strings.HasPrefix(l, "\t") {
			near = append(near, strings.TrimSpace(l))
		}
	}
	if len(near) == 0 && cmd != nil {
		// cobra's own suggestions come only from its legacy argument check, which a command with Args never
		// reaches; work them out the same way, within two edits as cobra does
		if cmd.SuggestionsMinimumDistance <= 0 {
			cmd.SuggestionsMinimumDistance = 2
		}
		near = cmd.SuggestionsFor(strings.Trim(word, `"`))
	}
	for _, n := range near {
		h.Suggestions = append(h.Suggestions, path+" "+n)
	}
	segments := strings.Fields(strings.TrimPrefix(path, "caitlyn"))
	why := "see the commands in " + path
	if len(segments) == 0 {
		why = "see every command"
	}
	h.Hint = &cmdutil.Hint{Next: []cmdutil.NextStep{{Run: path + " help", Why: why}}, Docs: gen.GroupDocsURL(segments)}
	return h
}

// Error formats: --error-format and CAITLYN_ERROR_FORMAT.
const (
	errorsHuman = "human"
	errorsJSON  = "json"
)

// errorFormatValue is --error-format.
type errorFormatValue struct{ g *cmdutil.Globals }

func (v errorFormatValue) String() string { return v.g.ErrorFormat }
func (v errorFormatValue) Type() string   { return "human|json" }
func (v errorFormatValue) Set(s string) error {
	switch s = strings.ToLower(s); s {
	case errorsHuman, errorsJSON:
		v.g.ErrorFormat = s
		return nil
	}
	return fmt.Errorf("--error-format takes human or json, not %q", s)
}

// errorFormat is how errors are printed, when something says: --error-format, then CAITLYN_ERROR_FORMAT. "" leaves
// it to who is reading stderr.
func errorFormat(f *cmdutil.Factory) string {
	if f.Globals.ErrorFormat != "" {
		return f.Globals.ErrorFormat
	}
	switch v := strings.ToLower(strings.TrimSpace(f.IO.Getenv("CAITLYN_ERROR_FORMAT"))); v {
	case errorsHuman, errorsJSON:
		return v
	}
	return ""
}

// report prints an error for whoever reads stderr (4.5, 18.2). --output shapes a command's data, not its errors.
// --error-format, then CAITLYN_ERROR_FORMAT, decide when set. Otherwise: an AI agent reading text gets short "try:"
// lines; scripts, CI and AI agents (stderr not a terminal, or CI or agent mode) get problem details as JSON; and a
// person at a terminal gets the full block, with the command's usage for a usage error.
func report(f *cmdutil.Factory, u *ui.UI, e *cmdutil.Error, cmd *cobra.Command) {
	human := func() {
		if e.Code == "USAGE" && cmd != nil {
			if e.Human == nil {
				e.Human = &cmdutil.HumanForm{}
			}
			e.Human.Usage = usageLines(cmd)
		}
		u.RenderError(f.IO.ErrOut, e)
	}
	machine := func() {
		b, _ := jsonMarshal(e.JSON())
		fmt.Fprintf(f.IO.ErrOut, "%s\n", b)
	}
	switch errorFormat(f) {
	case errorsHuman:
		human()
		return
	case errorsJSON:
		machine()
		return
	}
	format := f.Globals.Output
	if format == "" {
		if v, err := output.Resolve(f); err == nil {
			format = v
		}
	}
	switch {
	case f.Agent.On && format == output.Text:
		u.RenderErrorLines(f.IO.ErrOut, e)
	case !f.IO.IsStderrTTY() || f.Agent.On || f.CI.In():
		machine()
	default:
		human()
	}
}

// usageLines is a command's short usage, as a usage error shows it: a group's form with <command>, or the command's
// own line.
func usageLines(cmd *cobra.Command) []string {
	if cmd.HasAvailableSubCommands() {
		return []string{cmd.CommandPath() + " <command> [flags]"}
	}
	return []string{cmd.UseLine()}
}

// New builds the root command and its tree. u is replaced once the global flags are known.
func New(f *cmdutil.Factory, u **ui.UI) (*cobra.Command, error) {
	g := f.Globals
	root := &cobra.Command{
		Use:           "caitlyn",
		Short:         "Caitlyn on the command line",
		Long:          "Agents, knowledge bases, chat, unattended runs and configuration as code, from a terminal, a script or CI.\n\nOutput is a table on a terminal and JSON when piped. Errors are a message for people at a terminal, and problem\ndetails with an exit code for scripts, CI and AI agents. `caitlyn <command> help` explains any command.\nDocs: https://build.caitlyn.ai/cli/",
		SilenceErrors: true,
		SilenceUsage:  true,
		Args:          cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return Welcome(f, *u, cmd)
		},
		CompletionOptions: cobra.CompletionOptions{HiddenDefaultCmd: true},
	}
	pf := root.PersistentFlags()
	pf.StringVar(&g.Profile, "profile", "", "The profile to use (default: CAITLYN_PROFILE, then the project file, then default)")
	pf.StringVar(&g.Workspace, "workspace", "", "The workspace, for example your-company.caitlyn.ai, instead of the profile's")
	pf.StringVarP(&g.Output, "output", "o", "", "table, json, jsonl, yaml or text (default: table on a terminal, JSON when piped)")
	pf.Var(errorFormatValue{g}, "error-format", "human or json: how errors are printed on stderr (default: human for a person at a terminal, JSON for scripts, CI and AI agents)")
	pf.StringVar(&g.Query, "query", "", "A JMESPath expression over the result")
	pf.StringVar(&g.JQ, "jq", "", "A jq expression over the result (no jq binary needed)")
	pf.StringVar(&g.Color, "color", "", "always, never or auto")
	pf.BoolVar(&g.NoColor, "no-color", false, "No colour (the same as --color never)")
	pf.BoolVar(&g.NoPager, "no-pager", false, "Don't page long output")
	pf.BoolVar(&g.NoInput, "no-input", false, "Never prompt; anything that would ask exits 3 and names the flag that answers it")
	pf.BoolVarP(&g.Yes, "yes", "y", false, "Answer yes: run a destructive or user-facing command without asking")
	pf.StringVar(&g.Confirm, "confirm", "", "Name the target of the highest-impact commands (AI agents and CI)")
	pf.StringVar(&g.DryRun, "dry-run", "", "Print the request and send nothing; --dry-run=curl prints it as curl")
	pf.Lookup("dry-run").NoOptDefVal = "request"
	pf.StringVar(&g.Debug, "debug", "", "Print each request and response on stderr, credentials redacted; --debug=body adds bodies")
	pf.Lookup("debug").NoOptDefVal = "requests"
	pf.StringVar(&g.ProjectFile, "project-file", "", "Read this project file instead of finding .caitlyn.toml")
	pf.BoolVar(&g.NoProjectFile, "no-project-file", false, "Ignore any .caitlyn.toml")
	_ = root.RegisterFlagCompletionFunc("output", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return output.Formats, cobra.ShellCompDirectiveNoFileComp
	})
	_ = root.RegisterFlagCompletionFunc("error-format", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return []string{errorsHuman, errorsJSON}, cobra.ShellCompDirectiveNoFileComp
	})
	root.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error {
		e := cmdutil.Usagef("%v", err)
		e.Hint = &cmdutil.Hint{Docs: gen.DocsURL(strings.Fields(strings.TrimPrefix(cmd.CommandPath(), "caitlyn ")))}
		e.AddNext(cmd.CommandPath()+" --help", "see its flags")
		return e
	})
	uiRef = u
	root.PersistentPreRunE = func(cmd *cobra.Command, args []string) error {
		if cmd.DisableFlagParsing {
			return nil // `caitlyn api` reads its own flags, then calls prepare
		}
		return prepare(f, cmd)
	}
	root.AddCommand(newAPICommand(f))
	for _, add := range AddCommands {
		add(root, f)
	}
	if _, err := gen.Build(root, f); err != nil {
		return nil, err
	}
	applyGroupHelp(root, f.Overlay())
	root.InitDefaultHelpCmd()
	root.InitDefaultCompletionCmd()
	return root, nil
}

func truthy(v string) bool {
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// uiRef is where the root command keeps its UI, replaced once the global flags are known.
var uiRef **ui.UI

// prepare applies the global flags: prompts, decoration, configuration and the design system, then BeforeRun.
func prepare(f *cmdutil.Factory, cmd *cobra.Command) error {
	g := f.Globals
	if g.NoColor {
		g.Color = "never"
	}
	if g.NoInput || truthy(f.IO.Getenv("CAITLYN_NO_INPUT")) || f.CI.In() || f.Agent.On {
		f.IO.NeverPrompt = true
	}
	f.IO.Decorate = !f.CI.In() && !f.Agent.On
	if _, err := f.Config(); err != nil {
		// config commands must still run to fix a broken file
		if !strings.HasPrefix(cmd.CommandPath(), "caitlyn config") {
			return err
		}
	}
	SetupUI(f)
	if g.Debug != "" && g.Debug != "requests" && g.Debug != "body" {
		return cmdutil.Usagef("--debug takes no value, or body")
	}
	if g.DryRun != "" && g.DryRun != "request" && g.DryRun != "curl" {
		return cmdutil.Usagef("--dry-run takes no value, or curl")
	}
	if v := strings.TrimSpace(f.IO.Getenv("CAITLYN_ERROR_FORMAT")); v != "" && errorFormat(f) == "" {
		return cmdutil.Usagef("CAITLYN_ERROR_FORMAT takes human or json, not %q", v)
	}
	startTraces(f, cmd)
	for _, h := range BeforeRun {
		h(f, cmd)
	}
	return checkHandWritten(f, cmd)
}

// startTraces starts "your own traces" for the run when an OTLP endpoint is set (traces.otlp_endpoint, or
// OTEL_EXPORTER_OTLP_ENDPOINT): a root span the command's API calls nest under. Usage data for Caitlyn plays no part.
func startTraces(f *cmdutil.Factory, cmd *cobra.Command) {
	if f.Traces != nil {
		return
	}
	endpoint := ""
	if cfg, err := f.Config(); err == nil && cfg != nil {
		endpoint = cfg.String("traces.otlp_endpoint")
	}
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, run := traces.Start(ctx, traces.Settings{Lookup: f.IO.LookupEnv, Endpoint: endpoint, Version: f.Version})
	f.Traces = run
	if run.On() {
		cmd.SetContext(ctx)
	}
}

// checkHandWritten makes the read-only and agent-scope checks for a hand-written command that calls Caitlyn (one
// with an operation or scope annotation), from what it declares: the same checks every generated command makes
// (18.5). What depends on its flags (kb sync --remove-missing, apply --publish) the command checks itself.
func checkHandWritten(f *cmdutil.Factory, cmd *cobra.Command) error {
	ann := cmd.Annotations
	if ann["generated"] != "" || (ann["operation"] == "" && ann["scope"] == "") {
		return nil
	}
	impact := ann["impact"]
	if impact == "" {
		impact = "write"
	}
	a := gen.Action{Name: cmd.CommandPath(), Impact: impact}
	if ops := ann["operation"]; ops != "" {
		for _, op := range strings.Split(ops, ",") {
			a.Scopes = append(a.Scopes, gen.ScopesOf(f.Manifest(), strings.TrimSpace(op))...)
		}
	} else {
		a.Scopes = strings.Split(ann["scope"], ",")
	}
	return gen.Allowed(f, a)
}

// SetupUI decides colour, depth, background and glyphs from the global flags, the configuration and the
// environment, and installs the UI every command draws with. --help calls it too, since cobra answers --help before
// the root's PersistentPreRunE runs.
func SetupUI(f *cmdutil.Factory) {
	g, u := f.Globals, uiRef
	if g.NoColor {
		g.Color = "never"
	}
	cfg, _ := f.Config()
	s := ui.Settings{ColorFlag: g.Color, Plain: f.Agent.On, CIANSI: f.CI.RendersANSI()}
	if cfg != nil {
		s.ColorConfig = cfg.Get("color").Value
		if cfg.Get("color").Origin == "default" {
			s.ColorConfig = ""
		}
		s.Theme = cfg.String("theme")
		s.Glyphs = cfg.String("glyphs")
		s.Accessible = cfg.Bool("accessible_colors")
	}
	UISettings(f, &s)
	*u = ui.Setup(f.IO, s)
	uu := *u
	gen.UIFor = func(*cmdutil.Factory) *ui.UI { return uu }
}

// applyGroupHelp gives each command group and hand-written command the overlay's help (naming.yaml groups and
// commands): its one line, its paragraph and examples, for `caitlyn help` and the docs pages alike.
func applyGroupHelp(root *cobra.Command, o *spec.Overlay) {
	for _, set := range []map[string]*spec.GroupHelp{o.Groups, o.Commands} {
		for path, g := range set {
			c, _, err := root.Find(strings.Fields(path))
			if err != nil || c == root || g == nil {
				continue
			}
			if g.Short != "" {
				c.Short = g.Short
			}
			if gc := gen.Of(c); g.Long != "" && gc != nil && gc.Op != nil {
				// A generated command keeps the rest of its help (what it needs, its impact, how it fails): only the
				// model's description at its start is replaced
				doc := strings.TrimSpace(gc.Op.Documentation)
				if strings.HasPrefix(c.Long, doc) {
					c.Long = strings.TrimSpace(g.Long) + c.Long[len(doc):]
				}
				if c.Annotations == nil {
					c.Annotations = map[string]string{}
				}
				c.Annotations[AnnotationLongFromOverlay] = "true"
			} else if g.Long != "" {
				c.Long = strings.TrimSpace(g.Long)
				if c.Annotations == nil {
					c.Annotations = map[string]string{}
				}
				// the docs take this text, not the model's, for a generated command too
				c.Annotations[AnnotationLongFromOverlay] = "true"
			}
			if g.About != "" {
				c.Long = strings.TrimSpace(strings.TrimSpace(g.About) + "\n\n" + c.Long)
			}
			if g.Recipe != "" {
				c.Long = strings.TrimSpace(c.Long + "\n\n" + g.Recipe)
			}
			if len(g.Examples) > 0 {
				c.Example = "  " + strings.Join(g.Examples, "\n  ")
			}
		}
	}
}

// AnnotationLongFromOverlay marks a command whose description naming.yaml gives, in place of the model's (describe
// reads it for the docs).
const AnnotationLongFromOverlay = "help.long.overlay"
