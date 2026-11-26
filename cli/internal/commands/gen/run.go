package gen

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci/cisession"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
	"github.com/caitlyn-ai/sdk/cli/internal/skew"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// Run is the state of one run of a generated command, for hooks and hints.
type Run struct {
	F     *cmdutil.Factory
	C     *Command
	Cobra *cobra.Command
	Args  []string
	In    *invoke.Input
	// IDs are the identifier values given, by identifier name (agentId, knowledgeBaseId, version).
	IDs map[string]string
	UI  *ui.UI
}

// UIFor returns the UI the root command set up.
var UIFor = func(f *cmdutil.Factory) *ui.UI { return ui.New(f.IO) }

func (c *Command) run(f *cmdutil.Factory, cmd *cobra.Command, args []string) error {
	r := &Run{F: f, C: c, Cobra: cmd, Args: args, IDs: map[string]string{}, UI: UIFor(f)}
	err := r.do(cmd.Context())
	if err != nil {
		return r.Hint(err)
	}
	// --fail-on's generic conditions (deprecated, skew) decide the exit code of a run that succeeded (15.6)
	return r.Hint(cisession.For(f).Finish(0))
}

// clearSecrets asks the CI session before a response holding a secret is printed (15.2): refused in CI without
// --show-secret, masked first where the provider can.
func (r *Run) clearSecrets(op *spec.Operation, body []byte) error { return ClearSecrets(r.F, op, body) }

// ClearSecrets is clearSecrets for any command that prints an operation's response (caitlyn api).
func ClearSecrets(f *cmdutil.Factory, op *spec.Operation, body []byte) error {
	for _, v := range secretsIn(f.Manifest(), op, body) {
		if err := cisession.For(f).Secret(v); err != nil {
			return err
		}
	}
	return nil
}

// ImpactOf is an operation's impact class as its generated command has it, for commands that call operations
// directly (caitlyn api).
func ImpactOf(f *cmdutil.Factory, op *spec.Operation) string {
	if Current != nil {
		if cs := Current.ByOp[op.Name]; len(cs) > 0 {
			return cs[0].Impact
		}
	}
	return Impact(f.Overlay(), op, "")
}

func (r *Run) do(ctx context.Context) error {
	c, f := r.C, r.F
	if err := r.guard(); err != nil {
		return err
	}
	if err := r.input(); err != nil {
		return err
	}
	if c.Op == nil {
		return r.wait(ctx, c.Spec.Waits, nil)
	}
	if b, _ := r.Cobra.Flags().GetBool("generate-input"); b {
		return Skeleton(f.IO.Out, f.Manifest(), c.Op, r.In)
	}
	if err := r.confirm(); err != nil {
		return err
	}
	if b, _ := r.Cobra.Flags().GetBool("estimate"); b && c.Spec.Estimate != "" {
		est := f.Manifest().Op(c.Spec.Estimate)
		if est == nil {
			return fmt.Errorf("%s has no estimate operation in this release", c.Op.Name)
		}
		in := invoke.NewInput()
		for k, v := range r.In.Values {
			if est.Member(k) != nil {
				in.Set(k, v)
			}
		}
		return r.call(ctx, est, in)
	}
	if f.Globals.DryRun != "" {
		return DryRun(f, c.Op, r.In)
	}
	return r.call(ctx, c.Op, r.In)
}

func (r *Run) call(ctx context.Context, op *spec.Operation, in *invoke.Input) error {
	f := r.F
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return err
	}
	p, err := output.New(f, r.UI)
	if err != nil {
		return err
	}
	switch {
	case op.SSE != nil:
		return r.stream(ctx, p, op, in)
	case op.Paginated != nil:
		all, _ := r.Cobra.Flags().GetBool("all")
		maxItems, _ := r.Cobra.Flags().GetInt("max-items")
		cursor, _ := r.Cobra.Flags().GetString("cursor")
		noun := strings.ReplaceAll(r.C.Spec.Path[len(r.C.Spec.Path)-2], "-", " ")
		if !strings.HasSuffix(noun, "s") {
			noun += " entries" // a group whose name isn't a plural noun, such as history: 3 history entries
		}
		return p.List(ctx, func(ctx context.Context, cur string) (*output.Page, error) {
			pin := invoke.NewInput()
			for _, k := range in.Order {
				pin.Set(k, in.Values[k])
			}
			if cur != "" {
				pin.Set(op.Paginated.InputToken, cur)
			}
			res, err := invoke.Call(ctx, cc, op, pin)
			if err != nil {
				return nil, err
			}
			var page struct {
				Items json.RawMessage `json:"items"`
				Next  *string         `json:"nextCursor"`
			}
			raw := map[string]json.RawMessage{}
			_ = json.Unmarshal(res.Body, &raw)
			var items []json.RawMessage
			_ = json.Unmarshal(raw[op.Paginated.Items], &items)
			_ = json.Unmarshal(res.Body, &page)
			next := ""
			if v, ok := raw[op.Paginated.OutputToken]; ok {
				_ = json.Unmarshal(v, &next)
			}
			r.noteVersion(res)
			if err := r.clearSecrets(op, res.Body); err != nil {
				return nil, err
			}
			return &output.Page{Raw: res.Body, Items: items, Next: next}, nil
		}, output.ListOptions{All: all, MaxItems: maxItems, Cursor: cursor, Shape: p.ItemShape(op), Noun: noun, Empty: r.emptyHint()})
	}
	res, err := invoke.Call(ctx, cc, op, in)
	if err != nil {
		return err
	}
	r.noteVersion(res)
	thing := res.Thing(op)
	if err := r.clearSecrets(op, thing); err != nil {
		return err
	}
	if w, _ := r.Cobra.Flags().GetBool("wait"); w {
		lr := r.C.Spec.LongRunning
		if lr == nil {
			lr = r.C.Spec.ScopeWatch
		}
		if lr != nil {
			if !p.Human || f.IO.IsStderrTTY() {
				r.afterWrite(op, thing, true)
			}
			return r.wait(ctx, lr, thing)
		}
	}
	if len(thing) == 0 {
		r.afterWrite(op, nil, false)
		return nil
	}
	if p.Human && r.C.Impact != "read" {
		r.afterWrite(op, thing, false)
		if !f.IO.IsStdoutTTY() {
			return p.Raw(thing, p.ThingShape(op))
		}
		return nil
	}
	if view := HumanViews[op.Name]; view != nil && p.Human {
		return view(f, UIFor(f), thing)
	}
	return p.Raw(thing, p.ThingShape(op))
}

// HumanViews draw an operation's result for people where the generic detail view says too little (a comparison is
// a diff, not a list of paths). Keyed by operation name; the hand-written commands' package fills it.
var HumanViews = map[string]func(f *cmdutil.Factory, u *ui.UI, body []byte) error{}

// afterWrite prints the success line on stderr: ✓ in the past tense, naming the thing (12.9).
func (r *Run) afterWrite(op *spec.Operation, thing []byte, waiting bool) {
	if r.F.Agent.On || r.C.Impact == "read" {
		return
	}
	what := strings.TrimSuffix(op.Title, ".")
	name := ""
	var obj map[string]any
	if json.Unmarshal(thing, &obj) == nil {
		for _, k := range []string{"name", "title", "id"} {
			if s, ok := obj[k].(string); ok && s != "" {
				name = s
				break
			}
		}
	}
	msg := "Done: " + lowerFirst(what)
	if name != "" {
		msg += " (" + name + ")"
	}
	if waiting {
		msg += ". Waiting for it to finish" + r.UI.G.Ellipsis
		r.UI.Infof("%s", msg)
		return
	}
	r.UI.Successf("%s.", msg)
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

func (r *Run) emptyHint() string {
	for _, c := range r.F.Manifest().Commands {
		if len(c.Path) == len(r.C.Spec.Path) && c.Verb() == "create" && strings.Join(c.Path[:len(c.Path)-1], " ") == strings.Join(r.C.Spec.Path[:len(r.C.Spec.Path)-1], " ") {
			line := "caitlyn " + c.Name()
			for _, id := range r.C.Idents {
				if v := r.IDs[id.ID.Identifier]; v != "" {
					line += " --" + id.Flag + " " + shellQuote(v)
				}
			}
			return line + " …"
		}
	}
	return ""
}

// noteVersion remembers the server's version for skew checks (8.2).
func (r *Run) noteVersion(res *invoke.Result) {
	if v := res.Header.Get("Caitlyn-Api-Version"); v != "" {
		NoteServerVersion(r.F, v)
	}
	if d := res.Header.Get("Deprecation"); d != "" && !deprecationWarned {
		deprecationWarned = true
		msg := r.C.Spec.Name() + " is deprecated"
		if s := res.Header.Get("Sunset"); s != "" {
			msg += "; it stops working on " + s
		}
		cisession.For(r.F).Deprecated(msg + ".")
		if !r.F.CI.In() {
			r.UI.Warnf("%s.", msg)
		}
	}
	if v := res.Header.Get("Caitlyn-Api-Version"); v != "" && !skewWarned {
		if m := r.F.Manifest(); skew.Compare(m.ModelVersion, v) > 0 {
			skewWarned = true
			cisession.For(r.F).Skew(fmt.Sprintf("The workspace runs Caitlyn %s, older than this CLI's model (%s): newer commands and members aren't available there.", v, m.ModelVersion))
		}
	}
}

var skewWarned bool

var deprecationWarned bool

// NoteServerVersion is set by the root command to cache the last-seen server version per profile.
var NoteServerVersion = func(*cmdutil.Factory, string) {}

func (r *Run) stream(ctx context.Context, p *output.Printer, op *spec.Operation, in *invoke.Input) error {
	cc, _, err := r.F.Clients(ctx)
	if err != nil {
		return err
	}
	until, _ := r.Cobra.Flags().GetString("until-match")
	limit, err := r.Timeout()
	if err != nil {
		return err
	}
	if limit > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, limit)
		defer cancel()
	}
	s, err := invoke.Open(ctx, cc, r.F.Manifest(), op, in)
	if err != nil {
		return err
	}
	defer s.Close()
	human := p.Human && !p.Filtered()
	if human && r.F.IO.IsStderrTTY() {
		r.UI.Infof("Listening %s Ctrl-C to stop", r.UI.G.Dot)
	}
	for ev, err := range s.Events() {
		if err != nil {
			if limit > 0 && ctx.Err() == context.DeadlineExceeded {
				return &cmdutil.Error{Exit: exitcode.Timeout, Code: "TIMEOUT", Title: fmt.Sprintf("Stopped after %s.", limit)}
			}
			return err
		}
		if human {
			HumanEvent(r.F.IO.Out, r.UI, ev)
		} else if err := p.Event(ev.Type, ev.ID, ev.Data); err != nil {
			return err
		}
		if until != "" {
			line, _ := json.Marshal(map[string]any{"type": ev.Type, "id": ev.ID, "data": ev.Data})
			if v, err := output.Decode(line); err == nil {
				ok, err := output.MatchJQ(v, until)
				if err != nil {
					return err
				}
				if ok {
					return nil
				}
			}
		}
	}
	return nil
}

// HumanEvent prints one event for people: the time, its type, and its data compactly. Unknown events print too.
var HumanEvent = func(w io.Writer, u *ui.UI, ev invoke.Event) {
	data := strings.TrimSpace(string(ev.Data))
	if len(data) > 160 {
		data = data[:157] + u.G.Ellipsis
	}
	fmt.Fprintf(w, "%s  %s  %s\n", u.S(ui.Muted, time.Now().Format("15:04:05")), u.S(ui.Strong, ev.Type), data)
}

// guard refuses, before anything is sent, what this run may not do (2.4 and 18.5).
func (r *Run) guard() error {
	c, f := r.C, r.F
	if c.Op == nil {
		return nil
	}
	if c.Op.Interactive {
		ws, _ := f.Workspace()
		e := cmdutil.Forbiddenf("NOT_AVAILABLE_TO_CREDENTIALS", "%s can only be done in Caitlyn while signed in.", c.Op.Title)
		if ws != "" {
			e.AddNext("open https://"+ws+"/", "do it in the Caitlyn app")
		}
		return e
	}
	cfg, err := f.Config()
	if err != nil {
		return err
	}
	// The workspace's release, as last seen: an operation newer than it is refused before anything is sent (8.2)
	if seen := skew.Load(cfg.Dir(), cfg.Profile()); seen != nil && c.Op.Since != "" && skew.Compare(c.Op.Since, seen.Version) > 0 {
		e := &cmdutil.Error{Exit: exitcode.NotSupported, Code: "NOT_SUPPORTED_BY_SERVER",
			Title:  fmt.Sprintf("caitlyn %s needs Caitlyn %s; this workspace runs %s.", c.Spec.Name(), c.Op.Since, seen.Version),
			Detail: "This command is newer than your workspace's release. Ask your administrator when it will be updated."}
		e.AddNext("caitlyn version", "see your workspace's release and what this CLI supports")
		return e
	}
	return Allowed(f, Action{Name: "caitlyn " + c.Spec.Name(), Impact: c.Impact, Scopes: scopesOf(c.Op)})
}

// confirm is Confirmed for this run.
func (r *Run) confirm() error {
	c := r.C
	a := Action{Name: "caitlyn " + c.Spec.Name(), Impact: c.Impact, Line: r.commandLine()}
	if c.Op != nil {
		a.Title = c.Op.Title
	}
	if c.Confirms != "" {
		a.Targets = []string{r.IDs[c.Confirms]}
	}
	for _, arg := range c.Args {
		if v := r.IDs[arg.ID.Identifier]; v != "" {
			a.Subjects = append(a.Subjects, v)
		}
	}
	for _, id := range c.Idents {
		if v := r.IDs[id.ID.Identifier]; v != "" {
			a.Subjects = append(a.Subjects, v)
		}
	}
	return Confirmed(r.F, a)
}

// Action is something a command is about to do, for the checks every command makes before it sends anything,
// generated or hand-written (18.5): the read-only profile, agent scopes, and the confirmations.
type Action struct {
	// Name is the command as people know it ("caitlyn api DeleteAgent"); Line the command line, for hints.
	Name, Line, Title string
	// Impact is read, write, user-facing or destructive.
	Impact string
	// Scopes are the OAuth scopes it needs. Unknown (nil) with a write impact: under an AI agent, only agent scopes
	// of full allow it (caitlyn api by method and path can't say what a path needs).
	Scopes        []string
	UnknownScopes bool
	// Targets are the identifiers --confirm must name, for the highest-impact actions (deleting an agent or a
	// knowledge base, publishing).
	Targets []string
	// Subjects are the identifiers the prompt names, so a person sees exactly what they're agreeing to.
	Subjects []string
}

func scopesOf(op *spec.Operation) []string {
	if op == nil || op.Permission == nil {
		return nil
	}
	var out []string
	if op.Permission.Scope != "" {
		out = append(out, op.Permission.Scope)
	}
	return append(out, op.Permission.AlsoScopes...)
}

// ScopesOf is the scopes an operation needs, by name, from the manifest.
func ScopesOf(m *spec.Manifest, name string) []string { return scopesOf(m.Op(name)) }

// ReadOnly reports whether the profile, or CAITLYN_READ_ONLY, refuses writes.
func ReadOnly(f *cmdutil.Factory) bool {
	cfg, err := f.Config()
	return (err == nil && cfg.Bool("read_only")) || truthy(f.IO.Getenv("CAITLYN_READ_ONLY"))
}

// Allowed refuses, before anything is sent, an action the profile doesn't allow: a write on a read-only profile,
// and under an AI agent, anything outside the profile's agent scopes. Every command calls it, generated or not.
func Allowed(f *cmdutil.Factory, a Action) error {
	cfg, err := f.Config()
	if err != nil {
		return err
	}
	readOnly := ReadOnly(f)
	if readOnly && a.Impact != "read" {
		e := cmdutil.Forbiddenf("READ_ONLY_PROFILE", "This profile is read-only, and %s writes.", a.Name)
		e.Detail = "The profile, or CAITLYN_READ_ONLY, refuses every command that changes anything."
		e.AddNext("caitlyn --profile <a profile that can write> "+strings.TrimPrefix(a.Name, "caitlyn ")+" …", "use a profile that can write")
		return e
	}
	if !f.Agent.On {
		return nil
	}
	setting := cfg.Get("agent_scopes").List
	if v := cfg.Get("agent_scopes"); len(setting) == 0 && v.Value != "" {
		setting = []string{v.Value}
	}
	if len(setting) == 1 && setting[0] == agent.None {
		e := cmdutil.Forbiddenf("AGENT_NOT_ALLOWED", "AI agents may not use this profile.")
		e.Detail = "The person who signed in set this profile's agent scopes to none."
		e.AddNext(fmt.Sprintf("caitlyn config set agent_scopes read-only --profile %s", cfg.Profile()), "the person can allow agents to read (only a person can change this)")
		return e
	}
	allowed := agent.Effective(setting, nil, readOnly)
	full := len(setting) == 1 && setting[0] == agent.Full
	// A write whose scopes couldn't be found (an operation missing from the manifest, or with no permission) is
	// treated like a request by path: only full agent scopes allow it, never everything
	known := false
	for _, s := range a.Scopes {
		known = known || s != ""
	}
	if !known {
		a.UnknownScopes = true
	}
	if a.UnknownScopes && a.Impact != "read" && !full {
		e := cmdutil.Forbiddenf("AGENT_SCOPE_DENIED", "AI agents may not run %s with this profile: what it needs can't be checked.", a.Name)
		e.Detail = "This profile lets an AI agent do: " + agent.Describe(setting) + ". A request by method and path can only write when the agent scopes are full; call the operation by name instead."
		e.AddNext(fmt.Sprintf("caitlyn config set agent_scopes full --profile %s", cfg.Profile()), "the person can allow it (only a person can change this)")
		return e
	}
	for _, needed := range a.Scopes {
		if needed != "" && !agent.AnyCovers(allowed, needed) {
			e := cmdutil.Forbiddenf("AGENT_SCOPE_DENIED", "AI agents may not run %s with this profile: it needs %s.", a.Name, needed)
			e.Detail = "This profile lets an AI agent do: " + agent.Describe(setting) + "."
			e.AddNext(fmt.Sprintf("caitlyn config set agent_scopes %s --profile %s", needed, cfg.Profile()), "the person can allow it (only a person can change this)")
			return e
		}
	}
	return nil
}

// Confirmed asks before destructive actions, and in agent mode and CI requires --yes for destructive and
// user-facing ones, and --confirm naming the target for the highest-impact ones (18.5). --yes never comes from
// configuration or the environment.
func Confirmed(f *cmdutil.Factory, a Action) error {
	if a.Impact != "destructive" && a.Impact != "user-facing" {
		return nil
	}
	if f.Globals.DryRun != "" {
		return nil
	}
	line := a.Line
	if line == "" {
		line = a.Name
	}
	strict := f.Agent.On || f.CI.In()
	if len(a.Targets) > 0 && strict {
		given := map[string]bool{}
		for _, t := range strings.Split(f.Globals.Confirm, ",") {
			given[strings.TrimSpace(t)] = true
		}
		missing := false
		for _, t := range a.Targets {
			if !given[t] {
				missing = true
			}
		}
		if missing {
			want := shellQuote(strings.Join(a.Targets, ","))
			e := cmdutil.ActionNeeded(fmt.Sprintf("%s needs --confirm %s, naming the exact target.", a.Name, want), "--confirm")
			e.AddNext(line+" --dry-run", "see what it would send")
			e.AddNext(line+" --yes --confirm "+want, "then run it, naming the target")
			return e
		}
	}
	if f.Globals.Yes {
		return nil
	}
	if strict || (a.Impact == "destructive" && !f.Interactive()) {
		if a.Impact == "user-facing" && !strict {
			return nil
		}
		e := cmdutil.ActionNeeded(fmt.Sprintf("%s is %s and needs --yes.", a.Name, a.Impact), "--yes")
		e.AddNext(line+" --dry-run", "see what it would send")
		e.AddNext(line+" --yes", "then run it")
		return e
	}
	if a.Impact == "destructive" {
		what := strings.TrimSuffix(a.Title, ".")
		if what == "" {
			what = "Run " + a.Name
		}
		if subj := append(append([]string(nil), a.Targets...), a.Subjects...); len(subj) > 0 {
			seen, names := map[string]bool{}, []string{}
			for _, s := range subj {
				if !seen[s] {
					seen[s] = true
					names = append(names, s)
				}
			}
			what += " (" + strings.Join(names, ", ") + ")"
		}
		ok, err := Confirm(f, fmt.Sprintf("%s? This can't be undone.", what))
		if err != nil {
			return err
		}
		if !ok {
			return cmdutil.Silent(exitcode.ActionNeeded)
		}
	}
	return nil
}

// Confirm asks a yes/no question on the terminal ("no" is the default).
func Confirm(f *cmdutil.Factory, q string) (bool, error) {
	p, err := prompt.For(f.IO)
	if err != nil {
		return false, cmdutil.ActionNeeded("This needs a confirmation, and there is no terminal to ask on.", "--yes")
	}
	return p.Confirm(q, false)
}

func truthy(v string) bool {
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// commandLine is the command as typed, with the values given, for hints.
func (r *Run) commandLine() string {
	return CommandLine(append([]string{"caitlyn"}, r.C.Spec.Path...), r.Args, r.Cobra)
}

// CommandLine is a command as typed, for hints: path, then args and the flags given, quoted for a shell, without
// --yes, --confirm, --dry-run and the output flags (a hint adds the ones it means).
func CommandLine(path, args []string, cmd *cobra.Command) string {
	parts := append([]string(nil), path...)
	for _, a := range args {
		parts = append(parts, shellQuote(a))
	}
	cmd.Flags().Visit(func(fl *pflagFlag) {
		switch fl.Name {
		case "yes", "confirm", "dry-run", "output", "query", "jq", "debug":
			return
		}
		if fl.Value.Type() == "bool" {
			parts = append(parts, "--"+fl.Name)
			return
		}
		if sa, ok := fl.Value.(interface{ GetSlice() []string }); ok {
			for _, v := range sa.GetSlice() {
				parts = append(parts, "--"+fl.Name, shellQuote(v))
			}
			return
		}
		parts = append(parts, "--"+fl.Name, shellQuote(fl.Value.String()))
	})
	return strings.Join(parts, " ")
}

// readSecret reads a sensitive member from stdin or a file (3.1).
func readSecret(f *cmdutil.Factory, cmd *cobra.Command, flag string) (string, bool, error) {
	if b, _ := cmd.Flags().GetBool(flag + "-stdin"); b {
		data, err := io.ReadAll(f.IO.In)
		if err != nil {
			return "", false, err
		}
		return strings.TrimRight(string(data), "\r\n"), true, nil
	}
	if p, _ := cmd.Flags().GetString(flag + "-file"); p != "" {
		data, err := os.ReadFile(p)
		if err != nil {
			return "", false, cmdutil.Usagef("%s could not be read: %v", p, err)
		}
		return strings.TrimRight(string(data), "\r\n"), true, nil
	}
	return "", false, nil
}

// NewRun starts a run of a generated command, for a hook that takes over its RunE.
func (c *Command) NewRun(f *cmdutil.Factory, cmd *cobra.Command, args []string) *Run {
	return &Run{F: f, C: c, Cobra: cmd, Args: args, IDs: map[string]string{}, UI: UIFor(f)}
}

// Prepare checks what the run may do, assembles its input and asks for any confirmation it needs: everything a
// generated command does before it sends.
func (r *Run) Prepare() error {
	if err := r.guard(); err != nil {
		return err
	}
	if err := r.input(); err != nil {
		return err
	}
	return r.confirm()
}

// Wait waits as --wait does, after a hook's own call.
func (r *Run) Wait(ctx context.Context, lr *spec.LongRunning, thing []byte) error {
	return r.wait(ctx, lr, thing)
}

// WantsWait reports --wait.
func (r *Run) WantsWait() bool {
	b, _ := r.Cobra.Flags().GetBool("wait")
	return b
}
