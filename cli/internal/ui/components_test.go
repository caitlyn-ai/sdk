package ui

import (
	"bytes"
	"strings"
	"testing"
	"testing/iotest"
	"testing/synctest"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
)

func testUI(t *testing.T, tty bool, envs ...string) (*UI, *cmdutil.Factory, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	io, out, errOut := iostreams.Test("")
	io.SetTTY(tty, tty, tty)
	io.Decorate = true
	io.Environ = append([]string{"TERM=xterm-256color", "LANG=en_NZ.UTF-8"}, envs...)
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Home: t.TempDir(), WorkDir: t.TempDir()}
	return Setup(io, Settings{Theme: "dark"}), f, out, errOut
}

func TestMotionAllowed(t *testing.T) {
	_, f, _, _ := testUI(t, true)
	if !MotionAllowed(f) {
		t.Fatal("a terminal allows motion")
	}
	for name, setup := range map[string]func(f *cmdutil.Factory){
		"no terminal":              func(f *cmdutil.Factory) { f.IO.SetTTY(true, true, false) },
		"CI":                       func(f *cmdutil.Factory) { f.CI = ci.Provider{Name: "gitlab"} },
		"agent mode":               func(f *cmdutil.Factory) { f.Agent = agent.Mode{On: true} },
		"no decoration":            func(f *cmdutil.Factory) { f.IO.Decorate = false },
		"CAITLYN_SPINNER_DISABLED": func(f *cmdutil.Factory) { f.IO.Setenv("CAITLYN_SPINNER_DISABLED", "1") },
		"TERM=dumb":                func(f *cmdutil.Factory) { f.IO.Setenv("TERM", "dumb") },
	} {
		_, f, _, _ := testUI(t, true)
		setup(f)
		if MotionAllowed(f) {
			t.Errorf("%s: motion allowed", name)
		}
	}
}

// The spinner's delay and frames run on synctest's fake clock: time moves only when every goroutine in the bubble is
// blocked, so each sleep below is exact and the test never depends on how busy the machine is. The delay is the real
// SpinnerDelay: on the fake clock it costs nothing.
func TestSpinnerDelay(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		u, f, _, errOut := testUI(t, true)
		s := u.StartSpinner(f, "Planning the batch…")
		time.Sleep(SpinnerDelay - time.Millisecond) // timers: virtual (synctest)
		s.Stop()
		if errOut.Len() != 0 {
			t.Fatalf("a call that ends before SpinnerDelay shows nothing: %q", errOut.String())
		}
		// at exactly SpinnerDelay it shows (Wait lets the spinner draw before Stop)
		u, f, _, errOut = testUI(t, true)
		s = u.StartSpinner(f, "Planning the batch…")
		time.Sleep(SpinnerDelay) // timers: virtual (synctest)
		synctest.Wait()
		s.Stop()
		if !strings.Contains(errOut.String(), "Planning the batch…") {
			t.Fatalf("the spinner didn't show at SpinnerDelay: %q", errOut.String())
		}
		// a new label shows on the next frame
		u, f, _, errOut = testUI(t, true)
		s = u.StartSpinner(f, "Planning the batch…")
		time.Sleep(SpinnerDelay + 10*time.Millisecond) // timers: virtual (synctest)
		s.SetLabel("Uploading")
		time.Sleep(150 * time.Millisecond) // timers: virtual (synctest)
		s.Stop()
		got := errOut.String()
		if !strings.Contains(got, "Planning the batch…") || !strings.Contains(got, "Uploading") || !strings.ContainsAny(got, "⠋⠙⠹⠸") {
			t.Fatalf("spinner output %q", got)
		}
		if !strings.HasSuffix(got, "\r\x1b[K") {
			t.Errorf("Stop clears the line: %q", got)
		}
		// disabled: nothing, even after the delay
		u, f, _, errOut = testUI(t, true, "CAITLYN_SPINNER_DISABLED=1")
		s = u.StartSpinner(f, "x")
		time.Sleep(2 * SpinnerDelay) // timers: virtual (synctest)
		s.Stop()
		if errOut.Len() != 0 {
			t.Errorf("disabled spinner wrote %q", errOut.String())
		}
	})
}

func TestPlainProgressLines(t *testing.T) {
	u, f, _, errOut := testUI(t, false)
	start := time.Date(2026, 11, 25, 1, 2, 3, 0, time.UTC)
	now := start
	p := u.NewProgress(f, "Processing", Items, 100)
	p.Now = func() time.Time { return now }
	p.Phase("Processing", 100)
	for i := int64(1); i <= 100; i++ {
		now = now.Add(time.Second)
		p.Set(i)
	}
	lines := strings.Split(strings.TrimSpace(errOut.String()), "\n")
	// the phase line, then at most one every 10 s over 100 s, and the last
	if len(lines) < 10 || len(lines) > 12 {
		t.Fatalf("%d lines: %q", len(lines), lines)
	}
	if lines[0] != "2026-11-25T01:02:03Z Processing: 0 of 100 (0%)" {
		t.Errorf("first %q", lines[0])
	}
	if !strings.HasSuffix(lines[len(lines)-1], "Processing: 100 of 100 (100%)") {
		t.Errorf("last %q", lines[len(lines)-1])
	}
	if strings.Contains(errOut.String(), "\x1b") {
		t.Error("plain lines have no escape sequences")
	}
}

func TestProgressBar(t *testing.T) {
	u, f, _, _ := testUI(t, true)
	p := u.NewProgress(f, "Uploading", Bytes, 18_400_000)
	got := p.Bar(11_200_000, 30*time.Second)
	for _, want := range []string{"Uploading", "█", "░", "11.2 of 18.4 MB", "about 19 s left", "38;5;214"} {
		if !strings.Contains(got, want) {
			t.Errorf("bar %q lacks %q", got, want)
		}
	}
	if strings.Contains(got, "%") {
		t.Error("never a bare percentage")
	}
}

func TestDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{
		800 * time.Millisecond: "0.8 s", 2 * time.Second: "2 s", 24 * time.Second: "24 s", 112 * time.Second: "1 m 52 s",
		6*time.Minute + 12*time.Second: "6 m 12 s", 2 * time.Minute: "2 m", 125 * time.Minute: "2 h 5 m",
	} {
		if got := Duration(d); got != want {
			t.Errorf("%v: %q, want %q", d, got, want)
		}
	}
	if got := FormatBytes(18_400_000); got != "18.4 MB" {
		t.Errorf("bytes %q", got)
	}
	if got := FormatBytes(999); got != "999 B" {
		t.Errorf("bytes %q", got)
	}
}

func TestWordDiff(t *testing.T) {
	u, _, _, _ := testUI(t, false)
	got := u.wordDiff("a b c", "a x c d", 80)
	if len(got) != 1 || got[0] != "a [-b-] {+x+} c {+d+}" {
		t.Fatalf("%q", got)
	}
	// context: three lines around each change, the rest elided
	var before []string
	for i := 0; i < 40; i++ {
		before = append(before, "word")
	}
	after := append(append([]string{}, before...), "new")
	lines := u.wordDiff(strings.Join(before, " "), strings.Join(after, " "), 10)
	if lines[0] != u.G.Ellipsis || !strings.Contains(lines[len(lines)-1], "{+new+}") || len(lines) != 5 {
		t.Fatalf("%q", lines)
	}
	ops := diffWords(strings.Fields("the quick brown fox"), strings.Fields("the slow brown dog jumps"))
	var a, b []string
	for _, o := range ops {
		if o.op <= 0 {
			a = append(a, o.word)
		}
		if o.op >= 0 {
			b = append(b, o.word)
		}
	}
	if strings.Join(a, " ") != "the quick brown fox" || strings.Join(b, " ") != "the slow brown dog jumps" {
		t.Fatalf("the edit script doesn't rebuild both sides: %v", ops)
	}
}

func TestSplitClosedBlocks(t *testing.T) {
	cases := []struct{ in, closed, open string }{
		{"Hello wor", "", "Hello wor"},
		{"Para one.\n\nPara two", "Para one.\n\n", "Para two"},
		{"```go\nx := 1\n\ny := 2\n", "", "```go\nx := 1\n\ny := 2\n"},
		{"```go\nx := 1\n```\nafter", "```go\nx := 1\n```\n", "after"},
		{"- a\n- b\n\n", "- a\n- b\n\n", ""},
	}
	for _, c := range cases {
		closed, open := splitClosedBlocks(c.in)
		if closed != c.closed || open != c.open {
			t.Errorf("%q: %q + %q", c.in, closed, open)
		}
	}
	if rows("abcdef\nab", 4) != 3 || rows("", 80) != 1 {
		t.Error("rows")
	}
}

func TestChatNotATerminal(t *testing.T) {
	u, f, out, errOut := testUI(t, false)
	c := u.NewChatStream(f)
	c.Status("Searching")
	c.Write("Yes. **5 days** [1]")
	c.Finish([]Source{{N: 1, Title: "Leave policy, page 4", URL: "https://x.test/leave"}}, "HR assistant", "caitlyn chat --conversation c1")
	want := "Yes. **5 days** [1]\n\nSources:\n\n- [1] Leave policy, page 4: https://x.test/leave\n"
	if out.String() != want {
		t.Fatalf("raw Markdown: %q", out.String())
	}
	if errOut.String() != "HR assistant\n-> caitlyn chat --conversation c1\n" {
		t.Errorf("footer on stderr: %q", errOut.String())
	}
}

func TestMarkdown(t *testing.T) {
	u, _, _, _ := testUI(t, false)
	md := "# Title\n\nSome **bold** text [2].\n"
	if got := u.Markdown(md); got != md {
		t.Fatalf("not a terminal: raw Markdown, got %q", got)
	}
	u, _, _, _ = testUI(t, true)
	got := u.Markdown(md + "\n```\ncode\n```\n\n> quoted\n")
	for _, want := range []string{"\x1b[1m", "Title", "\x1b[38;5;208m[2]\x1b[m", "│", "code", "quoted"} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered %q lacks %q", got, want)
		}
	}
	if strings.Contains(got, "# Title") {
		t.Error("headings have no #")
	}
	for _, l := range strings.Split(got, "\n") {
		if strings.HasSuffix(l, " ") {
			t.Errorf("trailing space in %q", l)
		}
	}
}

func TestHelpTemplate(t *testing.T) {
	u, _, _, _ := testUI(t, false)
	root := &cobra.Command{Use: "caitlyn", Short: "Caitlyn on the command line"}
	root.PersistentFlags().StringP("output", "o", "", "table, json")
	save := &cobra.Command{
		Use:   "save <agent> --name <name>",
		Short: "Save the draft as a version  [Beta]",
		Long: "Saves the draft as a new named version, without changing live.\n\nNeeds:\n  agents.aliases.create (scope agents:write).\n\nImpact: Writes: changes drafts or your own work.\n\n" +
			"When it fails:\n  409 ALREADY_EXISTS     The agent already has a version with that name.  Exit code 7.\n\nAvailable from Caitlyn 5.144.0.  https://build.caitlyn.ai/cli/agents/draft/#save\n",
		Example: "  # Keep the tested draft as a version\n  caitlyn agents draft save GHT7YRWXPL --name november-candidate",
		RunE:    func(*cobra.Command, []string) error { return nil },
	}
	save.Flags().String("name", "", "The new version's name (required).")
	save.Flags().Bool("all", false, "Every page.")
	save.Flags().Lookup("all").NoOptDefVal = "true"
	save.Flags().Int("limit", 50, "Items per page.")
	save.Flags().String("dry-run", "", "Print the request")
	save.Flags().Lookup("dry-run").NoOptDefVal = "request"
	root.AddCommand(save)
	got := u.Help(save)
	order := []string{"Save the draft as a version  [Beta]", "Saves the draft", "Usage:", "caitlyn save <agent> --name <name>", "Flags:", "--name string", "Needs:", "Impact:", "Examples:", "# Keep the tested", "When it fails:", "409 ALREADY_EXISTS", "Available from Caitlyn 5.144.0."}
	at := 0
	for _, want := range order {
		i := strings.Index(got[at:], want)
		if i < 0 {
			t.Fatalf("help lacks %q after position %d:\n%s", want, at, got)
		}
		at += i
	}
	if strings.Contains(got, "true|false") || strings.Contains(got, "--all[=") {
		t.Errorf("boolean flags show no value:\n%s", got)
	}
	if !strings.Contains(got, "--limit int") || !strings.Contains(got, "(default 50)") || !strings.Contains(got, "--dry-run string[=request]") {
		t.Errorf("flags:\n%s", got)
	}
	rootHelp := u.Help(root)
	if !strings.Contains(rootHelp, "Commands:") || !strings.Contains(rootHelp, "caitlyn help exit-codes") {
		t.Errorf("root help:\n%s", rootHelp)
	}
}

func TestExitCodes(t *testing.T) {
	u, _, out, _ := testUI(t, false)
	u.ExitCodes(out, false)
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 13 || !strings.HasPrefix(lines[0], "0\tSucceeded") || !strings.HasPrefix(lines[12], "130\t") {
		t.Fatalf("%q", lines)
	}
}

func TestEventsAndIDs(t *testing.T) {
	u, _, out, _ := testUI(t, false)
	at := time.Date(2026, 11, 25, 14, 2, 11, 0, time.UTC)
	u.EventLine(out, at, EventStarted, "started", "3f9c2e7b-1a2b-4c3d-8e9f-0a1b2c3d5c60")
	if got := out.String(); got != "2026-11-25T14:02:11Z  ● started     3f9c2e7b-1a2b-4c3d-8e9f-0a1b2c3d5c60\n" {
		t.Errorf("piped: full times and IDs: %q", got)
	}
	u, _, _, _ = testUI(t, true)
	if got := u.ShortID("3f9c2e7b-1a2b-4c3d-8e9f-0a1b2c3d5c60"); got != "3f9c2e7b…5c60" {
		t.Errorf("short ID %q", got)
	}
	if got := u.ShortID("REVIEWER01"); got != "REVIEWER01" {
		t.Errorf("short IDs stay whole: %q", got)
	}
}

// The accessible prompts read plain answers, one per line (huh's accessible mode).
func TestPrompterAccessible(t *testing.T) {
	io, _, errOut := iostreams.Test("y\n")
	io.SetTTY(true, true, true)
	io.Environ = []string{"LANG=en_NZ.UTF-8"}
	p := &Prompter{U: Setup(io, Settings{Theme: "dark"}), Accessible: true}
	var _ prompt.Prompter = p
	if ok, err := p.Confirm("Apply this plan?", false); err != nil || !ok {
		t.Fatalf("confirm: %v %v", ok, err)
	}
	// each form reads its own answer, as a terminal gives one line at a time
	io.In = strings.NewReader("2\n")
	opts := []prompt.Option{{Label: "Tables"}, {Label: "JSON"}, {Label: "YAML"}}
	if i, err := p.Select("Output?", opts, 0); err != nil || i != 1 {
		t.Fatalf("select: %v %v", i, err)
	}
	// accessible multi-select toggles one number per line, 0 to finish; a terminal gives one line per read
	io.In = iotest.OneByteReader(strings.NewReader("1\n3\n0\n"))
	if got, err := p.MultiSelect("Scopes?", opts, nil); err != nil || len(got) != 2 || got[0] != 0 || got[1] != 2 {
		t.Fatalf("multi: %v %v", got, err)
	}
	io.In = strings.NewReader("november\n")
	if got, err := p.Input("Name?", "draft"); err != nil || got != "november" {
		t.Fatalf("input: %q %v", got, err)
	}
	if !strings.Contains(errOut.String(), "Apply this plan?") {
		t.Errorf("questions go to stderr: %q", errOut.String())
	}
}

// The selected option's marker is in the accent.
func TestPrompterMarker(t *testing.T) {
	io, _, _ := iostreams.Test("")
	io.SetTTY(true, true, true)
	io.Environ = []string{"TERM=xterm-256color", "COLORTERM=truecolor", "LANG=en_NZ.UTF-8"}
	p := &Prompter{U: Setup(io, Settings{Theme: "dark"})}
	st := p.Theme().Theme(true)
	if got := st.Focused.SelectSelector.Render(); got != "\x1b[38;2;255;187;38m›\x1b[m " {
		t.Errorf("selector %q", got)
	}
}
