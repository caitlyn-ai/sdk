// Package updatecmd is `caitlyn update [--check] [--channel stable|beta] [--version X.Y.Z] [--yes] [--rollback]`
// and the update notice (the CLI design, 8.4).
package updatecmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
	"github.com/caitlyn-ai/sdk/cli/internal/update"
)

// NewUpdater makes the updater for a run (tests replace it).
var NewUpdater = func(f *cmdutil.Factory) (*update.Updater, error) {
	u, err := update.New(baseURL(f), update.PublicKey)
	if err != nil {
		return nil, err
	}
	u.Client = f.HTTPClient
	return u, nil
}

func baseURL(f *cmdutil.Factory) string {
	if v := f.IO.Getenv(update.BaseURLEnv); v != "" {
		return v
	}
	return update.BaseURL
}

func configDir(f *cmdutil.Factory) string {
	if cfg, err := f.Config(); err == nil && cfg != nil {
		return cfg.Dir()
	}
	if d := f.IO.Getenv("CAITLYN_CONFIG_DIR"); d != "" {
		return d
	}
	home := f.Home
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".caitlyn")
}

func install(f *cmdutil.Factory, exe string) update.Install {
	return update.DetectInstall(update.Probe{Exe: exe, ConfigDir: configDir(f), Lookup: f.IO.LookupEnv})
}

func channelFor(f *cmdutil.Factory, flag string) (string, error) {
	ch := flag
	if ch == "" {
		if cfg, err := f.Config(); err == nil && cfg != nil {
			ch = cfg.String("update_channel")
		}
	}
	if ch == "" {
		ch = "stable"
	}
	for _, c := range update.Channels {
		if ch == c {
			return ch, nil
		}
	}
	return "", cmdutil.Usagef("%q is not a channel: use stable or beta", ch)
}

func asCLIError(err error) error {
	var ue *update.Error
	if errors.As(err, &ue) {
		e := &cmdutil.Error{Exit: exitcode.Failed, Code: ue.Code, Title: upper(ue.Msg) + ".", Cause: err}
		if ue.Err != nil {
			e.Detail = ue.Err.Error()
		}
		switch ue.Code {
		case update.CodeFetch:
			e.Exit = exitcode.Connection
		case update.CodeNoPrevious, update.CodeNoPlatform:
			e.Exit = exitcode.NotFound
		case update.CodeNotPermitted:
			e.Exit = exitcode.Forbidden
		}
		if ue.Code != update.CodeNoPrevious && ue.Code != update.CodeRolledBack {
			if e.Detail != "" && !strings.HasSuffix(e.Detail, ".") {
				e.Detail += "."
			}
			e.Detail = strings.TrimSpace(e.Detail + " The installed binary was not changed.")
		}
		return e
	}
	return cmdutil.FromError(err)
}

func upper(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

type checkView struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Channel   string `json:"channel"`
	Available bool   `json:"available"`
	Method    string `json:"installMethod"`
	Command   string `json:"command"`
}

// Add adds `caitlyn update`. It is one of root.AddCommands.
func Add(root *cobra.Command, f *cmdutil.Factory) {
	var check, rollback bool
	var channel, version string
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update the CLI, check for an update, or roll one back",
		Long: "Updates the CLI to the newest release on its channel, after verifying the release's signature and\n" +
			"checksum and that the new binary starts. The replaced binary is kept, so --rollback can restore it.\n" +
			"It never installs an older release unless --version names one.\n\n" +
			"Installed with Homebrew, Scoop, a deb or rpm package, go install or the container image? It prints\n" +
			"that tool's command instead of replacing the binary.",
		Example: "  caitlyn update --check\n  caitlyn update --yes\n  caitlyn update --channel beta\n  caitlyn update --version 0.12.0\n  caitlyn update --rollback",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			if rollback && (check || version != "" || channel != "") {
				return cmdutil.Usagef("--rollback takes no other update flags")
			}
			u, err := NewUpdater(f)
			if err != nil {
				return cmdutil.FromError(err)
			}
			inst := install(f, u.Exe)
			if rollback {
				if !inst.SelfUpdates() {
					return managed(f, inst, "", "roll back")
				}
				if err := confirm(f, "Roll back to the previous version?"); err != nil {
					return err
				}
				if err := u.Rollback(); err != nil {
					return asCLIError(err)
				}
				f.Stderrf("Rolled back to the previous version. caitlyn update --rollback again undoes it.\n")
				return nil
			}
			ch, err := channelFor(f, channel)
			if err != nil {
				return err
			}
			var rel *update.Release
			if version != "" {
				if _, err := update.ParseVersion(version); err != nil {
					return cmdutil.Usagef("--version %v", err)
				}
				rel, err = u.Version(ctx, version)
			} else {
				rel, err = u.Latest(ctx, ch)
			}
			if err != nil {
				return asCLIError(err)
			}
			target := rel.Manifest.Version
			newer := update.Newer(target, f.Version)
			if check {
				v := checkView{Current: f.Version, Latest: target, Channel: ch, Available: newer, Method: inst.Method, Command: inst.ManagerCommand(target)}
				return printCheck(f, v)
			}
			if version == "" && !newer {
				f.Stderrf("caitlyn %s is up to date (the %s channel's newest is %s).\n", f.Version, ch, target)
				return nil
			}
			if version != "" && target == f.Version {
				f.Stderrf("caitlyn %s is already installed.\n", target)
				return nil
			}
			if !inst.SelfUpdates() {
				return managed(f, inst, target, "update")
			}
			verb := "Update"
			if !newer {
				verb = "Downgrade"
			}
			if err := confirm(f, fmt.Sprintf("%s caitlyn %s to %s now?", verb, f.Version, target)); err != nil {
				return err
			}
			f.Stderrf("Downloading caitlyn %s for %s/%s…\n", target, u.GOOS, u.GOARCH)
			if err := u.Apply(ctx, rel); err != nil {
				return asCLIError(err)
			}
			dir := configDir(f)
			_ = update.SaveApplied(dir, update.Applied{From: f.Version, To: target, At: f.Now().UTC()})
			st := update.LoadNotice(dir)
			st.Latest, st.Notified, st.NotifiedAt = target, target, f.Now()
			_ = update.SaveNotice(dir, st)
			if channel != "" {
				if cfg, err := f.Config(); err == nil {
					if err := cfg.Set("update_channel", channel, "", false); err != nil {
						f.Stderrf("The %s channel couldn't be saved as your default: %v\n", channel, err)
					}
				}
			}
			f.Stderrf("Updated caitlyn %s to %s. caitlyn update --rollback restores %s.\n", f.Version, target, f.Version)
			return nil
		},
	}
	fl := cmd.Flags()
	fl.BoolVar(&check, "check", false, "Only say whether an update is available")
	fl.StringVar(&channel, "channel", "", "stable or beta (saved as your default when it updates; default: update_channel)")
	fl.StringVar(&version, "version", "", "Install this version, even an older one")
	fl.BoolVar(&rollback, "rollback", false, "Restore the version this one replaced")
	_ = cmd.RegisterFlagCompletionFunc("channel", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return update.Channels, cobra.ShellCompDirectiveNoFileComp
	})
	root.AddCommand(cmd)
}

func printCheck(f *cmdutil.Factory, v checkView) error {
	format, err := output.Resolve(f)
	if err != nil {
		return err
	}
	if format == output.Table || format == output.Text {
		if v.Available {
			fmt.Fprintf(f.IO.Out, "caitlyn %s is available (you have %s). Run %s.\n", v.Latest, v.Current, v.Command)
		} else {
			fmt.Fprintf(f.IO.Out, "caitlyn %s is up to date (the %s channel's newest is %s).\n", v.Current, v.Channel, v.Latest)
		}
		return nil
	}
	p, err := output.New(f, gen.UIFor(f))
	if err != nil {
		return err
	}
	return p.Value(v, "")
}

// managed refuses to replace a binary a package manager owns, and names the manager's command (exit 3).
func managed(f *cmdutil.Factory, inst update.Install, version, what string) error {
	run := inst.ManagerCommand(version)
	e := &cmdutil.Error{Exit: exitcode.ActionNeeded, Code: "UPDATE_BY_PACKAGE_MANAGER",
		Title:  fmt.Sprintf("This caitlyn was installed with %s, so %s it with that instead.", methodName(inst.Method), what),
		Detail: "Detected from " + inst.Source + "."}
	if what == "update" {
		e.AddNext(run, "update with "+methodName(inst.Method))
	}
	return e
}

func methodName(m string) string {
	switch m {
	case update.MethodHomebrew:
		return "Homebrew"
	case update.MethodScoop:
		return "Scoop"
	case update.MethodDeb:
		return "a deb package"
	case update.MethodRPM:
		return "an rpm package"
	case update.MethodGo:
		return "go install"
	case update.MethodContainer:
		return "the container image"
	}
	return m
}

func confirm(f *cmdutil.Factory, q string) error {
	if f.Globals.Yes {
		return nil
	}
	p, err := prompt.For(f.IO)
	if err != nil {
		return cmdutil.ActionNeeded("This replaces the installed binary; confirm it with --yes.", "--yes")
	}
	ok, err := p.Confirm(q, false)
	if err != nil {
		return cmdutil.FromError(err)
	}
	if !ok {
		return &cmdutil.Error{Exit: exitcode.ActionNeeded, Code: "DECLINED", Title: "Nothing was changed."}
	}
	return nil
}

// --------------------------------------------------------------------------------------------- the update notice

// noticeWait is how long the end of a run waits for the day's check, begun when the run started. A check that
// takes longer finishes in the background of the next run instead: the notice never delays a command.
const noticeWait = 300 * time.Millisecond

type pending struct{ done chan struct{} }

var (
	mu      sync.Mutex
	checks  = map[*cmdutil.Factory]*pending{}
	exempts = map[string]bool{"update": true, "version": true, "telemetry flush": true}
)

func commandName(cmd *cobra.Command) string {
	return strings.TrimSpace(strings.TrimPrefix(cmd.CommandPath(), "caitlyn"))
}

// noticeAllowed: on a TTY only; never in CI, in agent mode, with --no-input or CAITLYN_NO_UPDATE_NOTIFIER, or with
// update_notice = false (8.4).
func noticeAllowed(f *cmdutil.Factory, cmd *cobra.Command) (string, bool) {
	if cmd == nil || exempts[commandName(cmd)] {
		return "", false
	}
	if !f.IO.IsStderrTTY() || f.CI.In() || f.Agent.On || f.Globals.NoInput {
		return "", false
	}
	for _, k := range []string{"CAITLYN_NO_UPDATE_NOTIFIER", "CAITLYN_NO_INPUT"} {
		if v := strings.ToLower(f.IO.Getenv(k)); v != "" && v != "0" && v != "false" {
			return "", false
		}
	}
	mode := "true"
	if cfg, err := f.Config(); err == nil && cfg != nil {
		mode = strings.ToLower(cfg.String("update_notice"))
	}
	switch mode {
	case "false", "0", "off", "no":
		return "", false
	case "prompt":
		return "prompt", true
	}
	return "true", true
}

// BeforeRun starts the day's check in the background, and deletes a binary a Windows update moved aside. It is one
// of root.BeforeRun.
func BeforeRun(f *cmdutil.Factory, cmd *cobra.Command) {
	if runtime.GOOS == "windows" {
		if exe, err := os.Executable(); err == nil {
			update.CleanupOld(exe)
		}
	}
	dir := configDir(f)
	if a, ok := update.TakeApplied(dir); ok && f.Version != "" && a.To != f.Version && f.IO.IsStderrTTY() {
		f.Stderrf("caitlyn: the update to %s didn't take: this is %s. Run caitlyn update --rollback, or update again.\n", a.To, f.Version)
	}
	if _, ok := noticeAllowed(f, cmd); !ok {
		return
	}
	ch, err := channelFor(f, "")
	if err != nil {
		return
	}
	st := update.LoadNotice(dir)
	if !st.Due(f.Now(), ch) {
		return
	}
	u, err := NewUpdater(f)
	if err != nil {
		return
	}
	p := &pending{done: make(chan struct{})}
	mu.Lock()
	checks[f] = p
	mu.Unlock()
	go func() {
		defer close(p.done)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		ptr, err := u.Pointer(ctx, ch)
		st := update.LoadNotice(dir)
		st.CheckedAt, st.Channel = f.Now(), ch
		if err == nil {
			st.Latest = ptr.Version
		}
		_ = update.SaveNotice(dir, st)
	}()
}

// AfterRun prints the notice after the command's output, or asks with update_notice = prompt. It is one of
// root.AfterRun.
func AfterRun(f *cmdutil.Factory, cmd *cobra.Command, code int, took time.Duration) {
	mu.Lock()
	p := checks[f]
	delete(checks, f)
	mu.Unlock()
	mode, ok := noticeAllowed(f, cmd)
	if !ok {
		return
	}
	if p != nil {
		select {
		case <-p.done:
		case <-time.After(noticeWait):
		}
	}
	dir := configDir(f)
	st := update.LoadNotice(dir)
	if !st.ShouldNotify(f.Now(), f.Version) {
		return
	}
	st.Notified, st.NotifiedAt = st.Latest, f.Now()
	_ = update.SaveNotice(dir, st)
	exe, _ := os.Executable()
	inst := install(f, exe)
	if mode == "prompt" && inst.SelfUpdates() && f.IO.CanPrompt() {
		pr, err := prompt.For(f.IO)
		if err == nil {
			if yes, err := pr.Confirm(fmt.Sprintf("caitlyn %s is available (you have %s). Update to %s now?", st.Latest, f.Version, st.Latest), false); err == nil && yes {
				u, err := NewUpdater(f)
				if err == nil {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
					defer cancel()
					rel, err := u.Latest(ctx, st.Channel)
					// Install only what the person agreed to, and never an older release: the pointer may have
					// moved since the notice (M1)
					if err == nil && (rel.Manifest.Version != st.Latest || !update.Newer(rel.Manifest.Version, f.Version)) {
						err = fmt.Errorf("the channel now names %s, not the %s you agreed to; run caitlyn update to see what's available", rel.Manifest.Version, st.Latest)
					}
					if err == nil {
						err = u.Apply(ctx, rel)
					}
					if err != nil {
						f.Stderrf("The update didn't install: %v. The installed binary was not changed.\n", err)
						return
					}
					_ = update.SaveApplied(dir, update.Applied{From: f.Version, To: rel.Manifest.Version, At: f.Now().UTC()})
					f.Stderrf("Updated caitlyn %s to %s.\n", f.Version, rel.Manifest.Version)
				}
			}
			return
		}
	}
	f.Stderrf("caitlyn %s is available (you have %s). Run %s.\n", st.Latest, f.Version, inst.ManagerCommand(st.Latest))
}
