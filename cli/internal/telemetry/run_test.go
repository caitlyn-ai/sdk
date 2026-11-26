package telemetry_test

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/telemetry"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

var registerOnce sync.Once

func setup(t *testing.T) {
	registerOnce.Do(commands.Register)
	prev := telemetry.Spawn
	t.Cleanup(func() { telemetry.Spawn = prev })
	telemetry.Spawn = func([]string) error { return nil }
}

type run struct {
	code           int
	stdout, stderr string
	took           time.Duration
}

// cli runs the real CLI (every registered command and the generated tree) in a home of its own.
func cli(t *testing.T, home string, env map[string]string, tty bool, args ...string) run {
	t.Helper()
	io, out, errOut := iostreams.Test("")
	if tty {
		io.SetTTY(true, true, true)
	}
	io.Environ = []string{
		"CAITLYN_CONFIG_DIR=" + filepath.Join(home, ".caitlyn"),
		"CAITLYN_NO_UPDATE_NOTIFIER=1",
		"CAITLYN_UPDATE_URL=http://127.0.0.1:1/",
	}
	for k, v := range env {
		io.Setenv(k, v)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	start := time.Now()
	code := root.Run(ctx, io, args, func(f *cmdutil.Factory) { f.Home, f.WorkDir = home, home })
	return run{code, out.String(), errOut.String(), time.Since(start)}
}

func queued(t *testing.T, home string) []telemetry.Event {
	t.Helper()
	q := telemetry.Queue{Dir: filepath.Join(home, ".caitlyn", "telemetry")}
	evs, err := q.Pending()
	if err != nil {
		t.Fatal(err)
	}
	return evs
}

const endpoint = "http://127.0.0.1:1/v1/cli"

// Telemetry is opt-in (Sam, November 2026): the first interactive run asks once, and nothing is collected until the
// person turns it on, on every channel, beta included.
func TestFirstRunNoticeAsksAndCollectsNothing(t *testing.T) {
	setup(t)
	home := t.TempDir()
	e := map[string]string{telemetry.EndpointEnv: endpoint}
	r := cli(t, home, e, true, "version")
	if !strings.Contains(r.stderr, "Help improve the Caitlyn CLI") || !strings.Contains(r.stderr, "caitlyn telemetry on") {
		t.Fatalf("the first interactive run asks: %q", r.stderr)
	}
	if strings.Contains(r.stdout, "Help improve") {
		t.Fatal("the notice goes to stderr")
	}
	r = cli(t, home, e, true, "version")
	if strings.Contains(r.stderr, "Help improve") {
		t.Fatal("the notice is shown once")
	}
	cli(t, home, e, false, "version", "--json")
	if evs := queued(t, home); len(evs) != 0 {
		t.Fatalf("nothing is collected until it is turned on: %+v", evs)
	}
	// turned on, runs are collected, with and without a terminal
	if r := cli(t, home, e, true, "telemetry", "on"); r.code != 0 {
		t.Fatalf("on: %d %s", r.code, r.stderr)
	}
	cli(t, home, e, true, "version")
	cli(t, home, e, false, "version", "--json")
	evs := queued(t, home)
	if len(evs) != 2 || evs[0].TTY != [3]bool{true, true, true} || strings.Join(evs[1].Flags, ",") != "--json" {
		t.Fatalf("collected once on: %+v", evs)
	}
}

func TestNoTerminalNeverShowsTheNoticeAndCollectsNothing(t *testing.T) {
	setup(t)
	home := t.TempDir()
	r := cli(t, home, map[string]string{telemetry.EndpointEnv: endpoint}, false, "version")
	if strings.Contains(r.stderr, "Help improve") || len(queued(t, home)) != 0 {
		t.Fatal("no notice and nothing collected without a terminal")
	}
}

func TestFirstRunScreenHook(t *testing.T) {
	setup(t)
	var got string
	telemetry.FirstRunScreen = func(f *cmdutil.Factory, notice string) bool { got = notice; return true }
	t.Cleanup(func() { telemetry.FirstRunScreen = nil })
	r := cli(t, t.TempDir(), map[string]string{telemetry.EndpointEnv: endpoint}, true, "version")
	if got != telemetry.Notice || strings.Contains(r.stderr, "Help improve") {
		t.Fatal("the first-run screen draws the notice instead")
	}
}

func TestNoEndpointCollectsNothing(t *testing.T) {
	setup(t)
	home := t.TempDir()
	r := cli(t, home, nil, true, "version")
	cli(t, home, map[string]string{"CAITLYN_TELEMETRY": "1"}, true, "version")
	if strings.Contains(r.stderr, "Help improve") || len(queued(t, home)) != 0 {
		t.Fatal("with no endpoint, nothing is shown, queued or sent")
	}
}

func TestSwitchesThroughTheCLI(t *testing.T) {
	setup(t)
	cases := []struct {
		name    string
		env     map[string]string
		collect bool
	}{
		{"CI is off", map[string]string{"GITLAB_CI": "true"}, false},
		{"CI with CAITLYN_TELEMETRY=1", map[string]string{"GITLAB_CI": "true", "CAITLYN_TELEMETRY": "1"}, true},
		{"DO_NOT_TRACK", map[string]string{"DO_NOT_TRACK": "1"}, false},
		{"CAITLYN_TELEMETRY=0", map[string]string{"CAITLYN_TELEMETRY": "0"}, false},
		{"CAITLYN_TELEMETRY=1 beats DO_NOT_TRACK", map[string]string{"CAITLYN_TELEMETRY": "1", "DO_NOT_TRACK": "1"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			home := t.TempDir()
			c.env[telemetry.EndpointEnv] = endpoint
			cli(t, home, c.env, false, "version")
			if got := len(queued(t, home)) > 0; got != c.collect {
				t.Fatalf("collected %v, want %v", got, c.collect)
			}
			if c.collect {
				e := queued(t, home)[0]
				if c.env["GITLAB_CI"] != "" && (!e.CI || e.CIProvider != "gitlab") {
					t.Fatalf("CI provider: %+v", e)
				}
			}
		})
	}
}

func TestTelemetryOffDeletesTheQueueAndStatusSaysWhy(t *testing.T) {
	setup(t)
	home := t.TempDir()
	e := map[string]string{telemetry.EndpointEnv: endpoint}
	cli(t, home, e, true, "telemetry", "on")
	cli(t, home, e, true, "version")
	if len(queued(t, home)) != 1 {
		t.Fatal("setup: one event queued")
	}
	r := cli(t, home, e, true, "telemetry", "status", "--pending")
	if !strings.Contains(r.stdout, `"command":"version"`) {
		t.Fatalf("status --pending prints exactly what is queued: %q", r.stdout)
	}
	if r := cli(t, home, e, true, "telemetry", "off"); r.code != 0 {
		t.Fatalf("off: %d %s", r.code, r.stderr)
	}
	if len(queued(t, home)) != 0 {
		t.Fatal("turning it off deletes the queue")
	}
	cfg, _ := os.ReadFile(filepath.Join(home, ".caitlyn", "config"))
	if !strings.Contains(string(cfg), "telemetry = false") {
		t.Fatalf("off writes telemetry = false: %q", cfg)
	}
	r = cli(t, home, e, false, "telemetry", "status", "-o", "json")
	var st map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &st); err != nil || st["on"] != false || st["rule"] != float64(3) {
		t.Fatalf("status: %v %s", err, r.stdout)
	}
	cli(t, home, e, true, "version")
	if len(queued(t, home)) != 0 {
		t.Fatal("nothing is queued while it is off")
	}
	cli(t, home, e, true, "telemetry", "on")
	cli(t, home, e, true, "version")
	if len(queued(t, home)) != 1 {
		t.Fatal("on again")
	}
}

func TestUnknownFlagIsSentAsUnknown(t *testing.T) {
	setup(t)
	home := t.TempDir()
	e := map[string]string{"CAITLYN_TELEMETRY": "1", telemetry.EndpointEnv: endpoint}
	r := cli(t, home, e, false, "version", "--zqsecretvalue=zqhunter2", "--json")
	if r.code != 2 {
		t.Fatalf("exit %d", r.code)
	}
	evs := queued(t, home)
	b, _ := json.Marshal(evs)
	if len(evs) != 1 || !strings.Contains(string(b), `"unknown"`) || strings.Contains(string(b), "zq") {
		t.Fatalf("%s", b)
	}
}

// TestHangingEndpointDoesNotSlowACommand: a flush due at the end of a run runs detached; the run doesn't wait for it.
func TestHangingEndpointDoesNotSlowACommand(t *testing.T) {
	setup(t)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	home := t.TempDir()
	e := map[string]string{"CAITLYN_TELEMETRY": "1", telemetry.EndpointEnv: srv.URL}
	// The background flush, as a goroutine standing in for the detached process
	flushed := make(chan time.Duration, 1)
	q := telemetry.Queue{Dir: filepath.Join(home, ".caitlyn", "telemetry")}
	telemetry.Spawn = func(env []string) error {
		go func() {
			start := time.Now()
			_, _ = q.Flush(context.Background(), srv.URL, nil)
			flushed <- time.Since(start)
		}()
		return nil
	}
	for i := 0; i < 19; i++ {
		cli(t, home, e, false, "version")
	}
	r := cli(t, home, e, false, "version") // the 20th: a flush is due
	if r.took > time.Second {
		t.Fatalf("the run took %s with a hanging endpoint", r.took)
	}
	select {
	case took := <-flushed:
		if took > telemetry.PostTimeout+time.Second {
			t.Fatalf("the flush took %s, past its 3-second limit", took)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the flush never ended")
	}
	if n := len(queued(t, home)); n != 20 {
		t.Fatalf("a failed flush keeps the queue: %d", n)
	}
	// The flush command itself gives up after 3 seconds, silently
	telemetry.Spawn = func([]string) error { return nil }
	fr := cli(t, home, e, false, "telemetry", "flush")
	if fr.code != 0 || fr.stderr != "" || fr.took > telemetry.PostTimeout+time.Second {
		t.Fatalf("telemetry flush: exit %d in %s, %q", fr.code, fr.took, fr.stderr)
	}
}

// ---------------------------------------------------------------------------------------- the property test

// token is random argument text that can't occur in a payload by chance: 'z', 'q' and 'x' are not hexadecimal, so
// no UUID, and no command, flag or version, holds "zqx".
func token(r *rand.Rand) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := []byte("zqx")
	for i := 0; i < 8+r.IntN(8); i++ {
		b = append(b, alphabet[r.IntN(len(alphabet))])
	}
	return string(b)
}

type leaf struct {
	path  []string
	flags []*pflag.Flag
}

func walk(c *cobra.Command, path []string, out *[]leaf) {
	if c.Runnable() || len(c.Commands()) == 0 {
		var fl []*pflag.Flag
		c.Flags().VisitAll(func(f *pflag.Flag) { fl = append(fl, f) })
		c.InheritedFlags().VisitAll(func(f *pflag.Flag) { fl = append(fl, f) })
		*out = append(*out, leaf{append([]string(nil), path...), fl})
	}
	for _, s := range c.Commands() {
		walk(s, append(path, s.Name()), out)
	}
}

// TestNoArgumentTextInAnyPayload feeds random arguments through every command in the real tree (the generated
// commands included) and fails if any of their text reaches a payload (9.1, 17.2).
func TestNoArgumentTextInAnyPayload(t *testing.T) {
	setup(t)
	io, _, _ := iostreams.Test("")
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Now: time.Now}
	u := ui.New(io)
	tree, err := root.New(f, &u)
	if err != nil {
		t.Fatal(err)
	}
	var leaves []leaf
	walk(tree, nil, &leaves)
	if len(leaves) < 20 {
		t.Fatalf("only %d commands found: the tree wasn't built", len(leaves))
	}
	seed := uint64(time.Now().UnixNano())
	t.Logf("seed %d, %d commands", seed, len(leaves))
	r := rand.New(rand.NewPCG(seed, 7))
	home := t.TempDir()
	e := map[string]string{"CAITLYN_TELEMETRY": "1", telemetry.EndpointEnv: endpoint, "CAITLYN_WORKSPACE": ""}
	runs := 0
	for _, l := range leaves {
		if len(l.path) > 0 && l.path[0] == "telemetry" {
			continue // its own commands are never recorded
		}
		for variant := 0; variant < 3; variant++ {
			var args, tokens []string
			args = append(args, l.path...)
			add := func(a ...string) { args = append(args, a...) }
			for i := 0; i < 1+r.IntN(3); i++ {
				tok := token(r)
				tokens = append(tokens, tok)
				switch r.IntN(5) {
				case 0:
					add(tok) // a positional argument
				case 1:
					add("--" + tok) // an unknown flag
				case 2:
					v := token(r)
					tokens = append(tokens, v)
					add("--"+tok+"="+v, "-"+string(tok[3]))
				default:
					if len(l.flags) == 0 {
						add(tok)
						continue
					}
					fl := l.flags[r.IntN(len(l.flags))]
					if fl.Name == "help" || fl.Name == "version" {
						add(tok)
						continue
					}
					if fl.Value.Type() == "bool" {
						add("--"+fl.Name, tok)
					} else {
						add("--"+fl.Name, tok)
					}
				}
			}
			q := telemetry.Queue{Dir: filepath.Join(home, ".caitlyn", "telemetry")}
			_ = q.Delete()
			cli(t, home, e, false, args...)
			runs++
			evs, _ := q.Pending()
			if len(evs) != 1 {
				t.Fatalf("caitlyn %s: %d events queued", strings.Join(args, " "), len(evs))
			}
			b, _ := json.Marshal(evs[0])
			for _, tok := range tokens {
				if strings.Contains(string(b), tok) {
					t.Fatalf("argument text %q reached the payload of caitlyn %s:\n%s", tok, strings.Join(args, " "), b)
				}
			}
			if strings.Contains(string(b), "zqx") {
				t.Fatalf("argument text reached the payload of caitlyn %s:\n%s", strings.Join(args, " "), b)
			}
			if want := strings.Join(l.path, " "); evs[0].Command != want && !strings.HasPrefix(want, evs[0].Command) {
				t.Fatalf("command %q for %q", evs[0].Command, want)
			}
		}
	}
	t.Logf("%d runs", runs)
}

// On a fresh home, config and telemetry status say the same thing: off (round 6, M2)
func TestFreshHomeConfigAndStatusAgree(t *testing.T) {
	setup(t)
	home := t.TempDir()
	e := map[string]string{telemetry.EndpointEnv: endpoint}
	r := cli(t, home, e, false, "config", "get", "telemetry", "--show-origin")
	if !strings.HasPrefix(strings.TrimSpace(r.stdout), "false") {
		t.Fatalf("config get telemetry: %q", r.stdout)
	}
	r = cli(t, home, e, false, "telemetry", "status", "-o", "json")
	var st map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &st); err != nil || st["on"] != false {
		t.Fatalf("telemetry status: %v %q", err, r.stdout)
	}
}

// Usage data for Caitlyn carries the same normalised ci and agent values as the user agent: CAITLYN_CI and AI_AGENT
// are free text, so a raw name never reaches an event (round 10, from the telemetry intake's review).
func TestUsageEventCarriesTheUserAgentsValues(t *testing.T) {
	f := &cmdutil.Factory{Version: "0.12.0", Globals: &cmdutil.Globals{}, Now: time.Now,
		IO: &iostreams.IOStreams{Environ: []string{}}, Home: t.TempDir(), WorkDir: t.TempDir()}
	f.CI.Name = "My Weird CI!"
	f.Agent.On, f.Agent.Name = true, "Claude Code "+strings.Repeat("X", 28)
	e := telemetry.BuildEvent(f, &cobra.Command{Use: "version"}, 0, time.Second, telemetry.NewUUID(), false)
	if e.CIProvider != f.UserAgentCI() || e.CIProvider != "my-weird-ci-" {
		t.Errorf("ci_provider %q, the user agent's ci/ %q", e.CIProvider, f.UserAgentCI())
	}
	if e.AgentName != f.UserAgentAgent() || len(e.AgentName) != 32 {
		t.Errorf("agent_name %q, the user agent's agent/ %q", e.AgentName, f.UserAgentAgent())
	}
	f.Agent.Name = "???"
	if e := telemetry.BuildEvent(f, &cobra.Command{Use: "version"}, 0, time.Second, telemetry.NewUUID(), false); e.AgentName != "unknown" {
		t.Errorf("an agent name with nothing valid is %q, want unknown", e.AgentName)
	}
}
