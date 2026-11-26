package telemetry

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
)

// FirstRunScreen, when set, draws the first-run screen (the emblem helper's) with the notice in it, and returns
// true when it did. Unset, or returning false, the notice is printed as plain text.
var FirstRunScreen func(f *cmdutil.Factory, notice string) bool

// Spawn starts the detached background flush. Tests replace it.
var Spawn = func(env []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	c := exec.Command(exe, "telemetry", "flush")
	c.Env = env
	c.Stdin, c.Stdout, c.Stderr = nil, nil, nil
	detach(c)
	if err := c.Start(); err != nil {
		return err
	}
	return c.Process.Release()
}

// run is one run's telemetry state.
type run struct {
	noticeShown bool
	unknownFlag bool
}

var (
	mu   sync.Mutex
	runs = map[*cmdutil.Factory]*run{}
)

func runOf(f *cmdutil.Factory) *run {
	mu.Lock()
	defer mu.Unlock()
	r := runs[f]
	if r == nil {
		r = &run{}
		runs[f] = r
	}
	return r
}

// EndpointFor is the endpoint in use: CAITLYN_TELEMETRY_ENDPOINT, else the build's.
func EndpointFor(f *cmdutil.Factory) string {
	if v := f.IO.Getenv(EndpointEnv); v != "" {
		return v
	}
	return Endpoint
}

// Dir is the telemetry folder: the user folder's telemetry/ (~/.caitlyn/telemetry).
func Dir(f *cmdutil.Factory) string {
	if cfg, err := f.Config(); err == nil && cfg != nil {
		return filepath.Join(cfg.Dir(), "telemetry")
	}
	if d := f.IO.Getenv("CAITLYN_CONFIG_DIR"); d != "" {
		return filepath.Join(d, "telemetry")
	}
	home := f.Home
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".caitlyn", "telemetry")
}

// QueueFor is the run's queue.
func QueueFor(f *cmdutil.Factory) Queue { return Queue{Dir: Dir(f), Now: f.Now, Version: f.Version} }

// DecideFor applies the switches to this run.
func DecideFor(f *cmdutil.Factory) Decision {
	in := Inputs{Lookup: f.IO.LookupEnv, CI: f.CI.In(), Endpoint: EndpointFor(f)}
	if cfg, err := f.Config(); err == nil && cfg != nil {
		// Only the user file counts: CAITLYN_TELEMETRY is rule 1, and the project file can't set it (13.3).
		if v := cfg.Get("telemetry"); v.Origin == config.FromUser || v.Origin == config.FromProfile {
			in.UserSetting = v.Value
		}
	}
	return Decide(in)
}

// interactive is a run a person watches: stdin and stderr are terminals, and it isn't CI or an AI agent.
func interactive(f *cmdutil.Factory) bool {
	return f.IO.IsStdinTTY() && f.IO.IsStderrTTY() && !f.CI.In() && !f.Agent.On
}

// exempt are the runs telemetry ignores: its own commands (turning it off must not record a run, and the
// background flush must not queue itself).
func exempt(cmd *cobra.Command) bool {
	p := strings.Fields(strings.TrimPrefix(cmd.CommandPath(), "caitlyn"))
	return len(p) > 0 && p[0] == "telemetry"
}

// Register notes unknown flags, so they are sent as "unknown" (never their text). It is one of root.AddCommands.
func Register(root *cobra.Command, f *cmdutil.Factory) {
	prev := root.FlagErrorFunc()
	root.SetFlagErrorFunc(func(c *cobra.Command, err error) error {
		msg := err.Error()
		if strings.Contains(msg, "unknown flag") || strings.Contains(msg, "unknown shorthand flag") {
			runOf(f).unknownFlag = true
		}
		return prev(c, err)
	})
}

// BeforeRun shows the first-run notice, once, on the first interactive run while telemetry is off by default: it
// asks the person to turn it on, and nothing is collected unless they do. It is one of root.BeforeRun.
func BeforeRun(f *cmdutil.Factory, cmd *cobra.Command) {
	if exempt(cmd) {
		return
	}
	d := DecideFor(f)
	if d.On || d.Rule != 6 || EndpointFor(f) == "" || !interactive(f) {
		return
	}
	q := QueueFor(f)
	st := q.LoadState()
	if !st.NoticeShown.IsZero() {
		return
	}
	if FirstRunScreen == nil || !FirstRunScreen(f, Notice) {
		f.Stderrf("%s\n", Notice)
	}
	st.NoticeShown = f.Now().UTC()
	if st.InstallID == "" {
		st.InstallID = NewUUID()
	}
	if q.SaveState(st) == nil {
		runOf(f).noticeShown = true
	}
}

// FlagNames are the names of the flags the run used, from the command tree, sorted; "unknown" for an unknown flag.
func FlagNames(cmd *cobra.Command, unknown bool) []string {
	seen := map[string]bool{}
	names := []string{}
	cmd.Flags().Visit(func(fl *pflag.Flag) {
		n := "--" + fl.Name
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	})
	if unknown && !seen["unknown"] {
		names = append(names, "unknown")
	}
	sort.Strings(names)
	return names
}

// CommandName is the command's path in the tree, without "caitlyn".
func CommandName(cmd *cobra.Command) string {
	return strings.TrimSpace(strings.TrimPrefix(cmd.CommandPath(), "caitlyn"))
}

// BuildEvent is the run's event: only the fields in Event, every one from the command tree or the run's facts.
func BuildEvent(f *cmdutil.Factory, cmd *cobra.Command, code int, took time.Duration, installID string, unknownFlag bool) Event {
	channel := "stable"
	if cfg, err := f.Config(); err == nil && cfg != nil {
		channel = cfg.String("update_channel")
	}
	if channel != "stable" && channel != "beta" {
		channel = "unknown"
	}
	e := Event{
		EventID: NewUUID(), Time: FormatTime(f.Now().Add(-took)), InstallID: installID,
		Command: CommandName(cmd), Flags: FlagNames(cmd, unknownFlag), ExitCode: code,
		DurationMS: RoundDuration(took), Version: EventVersion(f.Version), Channel: channel,
		OS: runtime.GOOS, Arch: runtime.GOARCH, CI: f.CI.In(), Agent: f.Agent.On,
		TTY: [3]bool{f.IO.IsStdinTTY(), f.IO.IsStdoutTTY(), f.IO.IsStderrTTY()},
	}
	// The same normalised values the user agent's ci/ and agent/ tokens carry: CAITLYN_CI and AI_AGENT are free text
	if e.CI {
		e.CIProvider = f.UserAgentCI()
	}
	if e.Agent {
		e.AgentName = f.UserAgentAgent()
	}
	return e
}

// AfterRun queues the run's event, and starts a background flush when one is due. It never touches the network
// and never fails a run. It is one of root.AfterRun.
func AfterRun(f *cmdutil.Factory, cmd *cobra.Command, code int, took time.Duration) {
	mu.Lock()
	r := runs[f]
	delete(runs, f)
	mu.Unlock()
	if r == nil {
		r = &run{}
	}
	if cmd == nil || exempt(cmd) || r.noticeShown {
		return
	}
	d := DecideFor(f)
	// Only ever when the person turned it on (opt-in): the default never collects
	if !d.Collects() || !d.Explicit {
		return
	}
	q := QueueFor(f)
	if q.Gone(EndpointFor(f)) {
		return // the endpoint told this version to stop (410)
	}
	st := q.LoadState()
	id := st.InstallID
	if id == "" {
		var err error
		if id, err = q.InstallID(); err != nil {
			return
		}
	}
	due, err := q.Append(BuildEvent(f, cmd, code, took, id, r.unknownFlag))
	// No background flush while the endpoint asked to wait (Retry-After)
	if err != nil || !due || !q.WaitUntil(EndpointFor(f)).IsZero() || !q.ClaimSpawn() {
		return
	}
	env := append([]string(nil), f.IO.Environ...)
	if e := EndpointFor(f); e != "" {
		env = append(env, EndpointEnv+"="+e)
	}
	_ = Spawn(env)
}
