// Package cisession binds the CI reporters (package ci) to a run: the global flags --ci-format, --report,
// --summary-file, --outputs-file, --fail-on and --show-secret, and For, the session a command reports to.
//
// A command that reports phases, checks or outputs does:
//
//	run := cisession.For(f)
//	if err := run.AcceptFailOn(ci.SyncConditions, ci.SyncDefaults); err != nil {
//		return err
//	}
//	ph := run.Phase("plan", "Planning")
//	… ph.End(err) …
//	run.Case(ci.TestCase{Name: item, Status: ci.Failed, Message: why})
//	run.Hold("failed")
//	_ = run.Output("changes", "true")
//	return run.Finish(0) // applies --fail-on, writes the files; nil or a *cmdutil.Error with the exit code
//
// The files are written even when a command never calls Finish (it failed early, or never reported anything): the
// root command's AfterRun does it with the run's exit code.
package cisession

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
)

// state is a run's flags that cmdutil.Globals has no field for, and its session.
type state struct {
	showSecret bool
	run        *Run
	title      string
}

var (
	mu    sync.Mutex
	runs  = map[*cmdutil.Factory]*state{}
	exec_ ci.Execer
)

// SetExec replaces how buildkite-agent is run (tests).
func SetExec(e ci.Execer) {
	mu.Lock()
	defer mu.Unlock()
	exec_ = e
}

func stateOf(f *cmdutil.Factory) *state {
	mu.Lock()
	defer mu.Unlock()
	s := runs[f]
	if s == nil {
		s = &state{}
		runs[f] = s
	}
	return s
}

// reportValue is --report: repeatable, each checked as it is parsed.
type reportValue struct{ g *cmdutil.Globals }

func (v reportValue) String() string { return strings.Join(v.g.Reports, ",") }
func (v reportValue) Type() string   { return "format=path" }
func (v reportValue) Set(s string) error {
	if _, err := ci.ParseReport(s); err != nil {
		return err
	}
	v.g.Reports = append(v.g.Reports, s)
	return nil
}

// failOnValue is --fail-on: comma-separated or repeated, each condition checked as it is parsed.
type failOnValue struct{ g *cmdutil.Globals }

func (v failOnValue) String() string { return strings.Join(v.g.FailOn, ",") }
func (v failOnValue) Type() string   { return "conditions" }
func (v failOnValue) Set(s string) error {
	all := append(append([]string(nil), v.g.FailOn...), s)
	parsed, err := ci.ParseFailOn(all)
	if err != nil {
		return err
	}
	v.g.FailOn = parsed
	return nil
}

// formatValue is --ci-format.
type formatValue struct{ g *cmdutil.Globals }

func (v formatValue) String() string { return v.g.CIFormat }
func (v formatValue) Type() string   { return "plain|off" }
func (v formatValue) Set(s string) error {
	for _, f := range ci.Formats {
		if s == f {
			v.g.CIFormat = s
			return nil
		}
	}
	return fmt.Errorf("--ci-format takes plain or off (or auto), not %q", s)
}

// Register adds the global CI flags to the root command. It is one of root.AddCommands.
func Register(root *cobra.Command, f *cmdutil.Factory) {
	g := f.Globals
	st := stateOf(f)
	pf := root.PersistentFlags()
	pf.Var(formatValue{g}, "ci-format", "plain or off: turn off the CI provider's sections, annotations and summaries (auto in CI)")
	pf.Var(reportValue{g}, "report", "Write a report beside the output: junit=, markdown=, json= or annotations=<path> (repeatable)")
	pf.StringVar(&g.SummaryFile, "summary-file", "", "Write the run's Markdown summary to this file")
	pf.StringVar(&g.OutputsFile, "outputs-file", "", "Write output values as dotenv (GitLab's artifacts:reports:dotenv)")
	pf.Var(failOnValue{g}, "fail-on", "Exit non-zero when these hold: the command's conditions, deprecated, skew, or never")
	pf.BoolVar(&st.showSecret, "show-secret", false, "In CI, print a secret: auth token's, or a value the API marks sensitive (none yet). Masked first where the CI system can")
	_ = root.RegisterFlagCompletionFunc("ci-format", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return []string{"plain", "off"}, cobra.ShellCompDirectiveNoFileComp
	})
	_ = root.RegisterFlagCompletionFunc("fail-on", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		names := []string{}
		for _, c := range ci.Conditions {
			names = append(names, c.Name+"\t"+c.Doc)
		}
		return names, cobra.ShellCompDirectiveNoFileComp
	})
}

// BeforeRun names the session after the command that runs. It is one of root.BeforeRun.
func BeforeRun(f *cmdutil.Factory, cmd *cobra.Command) {
	stateOf(f).title = strings.TrimPrefix(cmd.CommandPath(), "caitlyn ")
}

// Run is a command's session: package ci's Session, with errors as the CLI's own.
type Run struct {
	*ci.Session
	f   *cmdutil.Factory
	err error
}

// For returns the run's session, made on first use.
func For(f *cmdutil.Factory) *Run {
	st := stateOf(f)
	mu.Lock()
	defer mu.Unlock()
	if st.run != nil {
		return st.run
	}
	g := f.Globals
	wd := f.WorkDir
	s, err := ci.NewSession(ci.Options{
		Provider: f.CI, Format: g.CIFormat, Out: f.IO.ErrOut, Lookup: f.IO.LookupEnv, Now: f.Now, Exec: exec_,
		WorkDir: wd, Reports: g.Reports, SummaryFile: g.SummaryFile, OutputsFile: g.OutputsFile, FailOn: g.FailOn,
		ShowSecret: st.showSecret, Title: st.title, Version: f.Version,
	})
	if err != nil {
		// The flags are checked as they are parsed, so this is a session with the flags' errors kept for Finish;
		// reporting still works, to nowhere.
		s, _ = ci.NewSession(ci.Options{Title: st.title})
	}
	st.run = &Run{Session: s, f: f, err: err}
	return st.run
}

// AcceptFailOn says which --fail-on conditions the command takes (ci.SyncConditions, …) and its defaults; one the
// person gave that it doesn't take is a usage error.
func (r *Run) AcceptFailOn(allowed, defaults []string) error {
	if r.err != nil {
		return cmdutil.Usagef("%v", r.err)
	}
	if err := r.Session.AcceptFailOn(allowed, defaults); err != nil {
		e := cmdutil.Usagef("%v", err)
		e.Code = "FAIL_ON_NOT_APPLICABLE"
		return e
	}
	return nil
}

// Secret is called before printing a secret: nil to print it, or the error to return (15.2).
func (r *Run) Secret(value string) error {
	err := r.Session.Secret(value)
	if err == nil {
		return nil
	}
	var se *ci.SecretError
	if errors.As(err, &se) && se.NeedsFlag {
		e := cmdutil.Usagef("This prints a secret, and CI logs are kept.")
		e.Code = "SECRET_IN_CI"
		e.Detail = "Write it to a file with --secret-file, or give --show-secret to print it (masked first where the CI system can)."
		e.Hint = &cmdutil.Hint{Missing: []string{"--secret-file", "--show-secret"}}
		return e
	}
	e := cmdutil.Forbiddenf("SECRET_UNMASKABLE", "%s CI can't mask a secret at run time, so the CLI won't print one.", providerTitle(r.f.CI.Name))
	e.Detail = "Write it to a file with --secret-file instead."
	e.Hint = &cmdutil.Hint{Missing: []string{"--secret-file"}}
	e.Cause = err
	return e
}

func providerTitle(name string) string {
	switch name {
	case "gitlab":
		return "GitLab"
	case "github":
		return "GitHub Actions"
	case "buildkite":
		return "Buildkite"
	case "azure":
		return "Azure Pipelines"
	}
	return "This"
}

// Finish applies --fail-on to code (the command's exit code so far, usually 0), publishes the summary and writes the
// files. It returns nil, or a *cmdutil.Error carrying the exit code the conditions call for.
func (r *Run) Finish(code int) error {
	res := r.Session.Finish(code)
	r.warn(res)
	if res.Exit == code || res.Exit == 0 {
		return nil
	}
	e := &cmdutil.Error{Exit: res.Exit, Code: "FAIL_ON", Title: fmt.Sprintf("Failing because of --fail-on %s.", strings.Join(res.FailedOn, ","))}
	if res.Exit == exitcode.ActionNeeded {
		e.Detail = "The outcome needs action. Give --fail-on never (or other conditions) to accept it."
	}
	return e
}

func (r *Run) warn(res ci.FinishResult) {
	for _, err := range res.Errors {
		fmt.Fprintf(r.f.IO.ErrOut, "caitlyn: couldn't write a CI file: %v\n", err)
	}
	if ign := r.Ignored(); len(ign) > 0 {
		fmt.Fprintf(r.f.IO.ErrOut, "caitlyn: --fail-on %s has no effect on this command\n", strings.Join(ign, ","))
	}
}

// AfterRun finishes the session if the command didn't, so the files are written whatever happened, and forgets the
// run. It is one of root.AfterRun.
func AfterRun(f *cmdutil.Factory, code int) {
	mu.Lock()
	st := runs[f]
	delete(runs, f)
	mu.Unlock()
	g := f.Globals
	wanted := len(g.Reports) > 0 || g.SummaryFile != "" || g.OutputsFile != ""
	if st == nil || (st.run == nil && !wanted) {
		return
	}
	if st.run == nil {
		mu.Lock()
		runs[f] = st
		mu.Unlock()
		For(f)
		mu.Lock()
		delete(runs, f)
		mu.Unlock()
	}
	res := st.run.Session.Finish(code)
	for _, err := range res.Errors {
		fmt.Fprintf(f.IO.ErrOut, "caitlyn: couldn't write a CI file: %v\n", err)
	}
}
