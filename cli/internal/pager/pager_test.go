package pager

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// The test binary doubles as a fake pager: it records what it read (and its LESS) to FAKE_PAGER_RECORD, and stops
// after FAKE_PAGER_LINES lines when that is set, as a person quitting would.
func TestMain(m *testing.M) {
	if rec := os.Getenv("FAKE_PAGER_RECORD"); rec != "" {
		fakePager(rec)
		return
	}
	os.Exit(m.Run())
}

func fakePager(rec string) {
	limit, _ := strconv.Atoi(os.Getenv("FAKE_PAGER_LINES"))
	f, err := os.Create(rec)
	if err != nil {
		os.Exit(2)
	}
	defer f.Close()
	fmt.Fprintf(f, "LESS=%s\n", os.Getenv("LESS"))
	sc := bufio.NewScanner(os.Stdin)
	n := 0
	for sc.Scan() {
		fmt.Fprintln(f, sc.Text())
		fmt.Println(sc.Text())
		n++
		if limit > 0 && n >= limit {
			return // quit early: the pipe closes
		}
	}
}

type fakeTerm struct {
	f        *cmdutil.Factory
	out, err *strings.Builder
	rec      string
}

func newTerm(t *testing.T, env ...string) *fakeTerm {
	t.Helper()
	io, _, _ := iostreams.Test("")
	out, errOut := &strings.Builder{}, &strings.Builder{}
	io.Out, io.ErrOut = &lockedWriter{w: out}, errOut
	io.SetTTY(true, true, true)
	io.Decorate = true
	rec := filepath.Join(t.TempDir(), "pager.txt")
	exe, _ := os.Executable()
	io.Environ = append([]string{"TERM=xterm", "LANG=en_NZ.UTF-8", "FAKE_PAGER_RECORD=" + rec, "CAITLYN_PAGER=" + exe}, env...)
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{Output: "table"}, Home: t.TempDir(), WorkDir: t.TempDir()}
	f.CI = ci.Detect(io.LookupEnv)
	return &fakeTerm{f: f, out: out, err: errOut, rec: rec}
}

// lockedWriter: the pager process writes to stdout from exec's copying goroutine.
type lockedWriter struct {
	w  io.Writer
	mu sync.Mutex
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func (tm *fakeTerm) recorded(t *testing.T) string {
	b, err := os.ReadFile(tm.rec)
	if err != nil {
		t.Fatalf("the pager never ran: %v", err)
	}
	return string(b)
}

func TestCommandChoice(t *testing.T) {
	io, _, _ := iostreams.Test("")
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Home: t.TempDir(), WorkDir: t.TempDir()}
	if cmd, configured := Command(f); cmd != "less -FRX" || configured {
		t.Errorf("default: %q %v", cmd, configured)
	}
	dir := filepath.Join(f.Home, ".caitlyn")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "config"), []byte("pager = \"most\"\n"), 0o600)
	f = &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Home: f.Home, WorkDir: t.TempDir()}
	if cmd, configured := Command(f); cmd != "most" || !configured {
		t.Errorf("config: %q %v", cmd, configured)
	}
	io.Setenv("PAGER", "more")
	if cmd, _ := Command(f); cmd != "more" {
		t.Errorf("$PAGER before config: %q", cmd)
	}
	io.Setenv("CAITLYN_PAGER", "bat")
	if cmd, _ := Command(f); cmd != "bat" {
		t.Errorf("$CAITLYN_PAGER first: %q", cmd)
	}
	io.Setenv("CAITLYN_PAGER", "")
	if cmd, configured := Command(f); cmd != "" || !configured {
		t.Errorf("an empty CAITLYN_PAGER turns paging off: %q", cmd)
	}
}

func TestEnviron(t *testing.T) {
	got := Environ([]string{"A=1"})
	if strings.Join(got, " ") != "A=1 LESS=FRX LV=-c" {
		t.Errorf("%q", got)
	}
	got = Environ([]string{"LESS=-R"})
	if strings.Join(got, " ") != "LESS=-R LV=-c" {
		t.Errorf("the person's LESS is kept: %q", got)
	}
}

func TestWhyNot(t *testing.T) {
	cases := map[string]func(tm *fakeTerm){
		"--no-pager":              func(tm *fakeTerm) { tm.f.Globals.NoPager = true },
		"no pager configured":     func(tm *fakeTerm) { tm.f.IO.Setenv("CAITLYN_PAGER", "cat") },
		"stdout isn't a terminal": func(tm *fakeTerm) { tm.f.IO.SetTTY(true, false, true) },
		"CI":                      func(tm *fakeTerm) { tm.f.CI = ci.Provider{Name: "gitlab"} },
		"agent mode":              func(tm *fakeTerm) { tm.f.Agent = agent.Mode{On: true} },
		"JSON output on a terminal is for copying": func(tm *fakeTerm) { tm.f.Globals.Output = "jsonl" },
	}
	for want, setup := range cases {
		tm := newTerm(t)
		setup(tm)
		if got := Why(tm.f); got != want {
			t.Errorf("%s: %q", want, got)
		}
		if Start(tm.f) {
			Stop(tm.f)
			t.Errorf("%s: paged", want)
		}
	}
	old := GOOS
	defer func() { GOOS = old }()
	GOOS = "windows"
	tm := newTerm(t)
	tm.f.IO.Environ = []string{"TERM=xterm"}
	if got := Why(tm.f); got != "Windows has no pager by default" {
		t.Errorf("windows: %q", got)
	}
	tm.f.IO.Setenv("PAGER", "more")
	if got := Why(tm.f); got != "" {
		t.Errorf("windows with a pager: %q", got)
	}
}

func TestPageThroughPager(t *testing.T) {
	tm := newTerm(t, "LINES=5")
	text := strings.Repeat("line\n", 20)
	if err := Page(tm.f, text); err != nil {
		t.Fatal(err)
	}
	got := tm.recorded(t)
	if !strings.HasPrefix(got, "LESS=FRX\n") || strings.Count(got, "line\n") != 20 {
		t.Fatalf("the pager read %q", got)
	}
	if tm.out.String() != text {
		t.Errorf("the pager's output reached the terminal: %q", tm.out.String())
	}
	if _, ok := tm.f.IO.Out.(*lockedWriter); !ok {
		t.Error("stdout is put back after the pager")
	}
	short := newTerm(t, "LINES=50")
	_ = Page(short.f, "short\n")
	if _, err := os.Stat(short.rec); err == nil {
		t.Error("output shorter than the screen isn't paged")
	}
}

// A list writes into the pager as pages arrive; quitting the pager stops the fetching, and the command exits 0.
func TestListFetchesOnlyAsRead(t *testing.T) {
	Install()
	tm := newTerm(t, "FAKE_PAGER_LINES=30")
	var fetched atomic.Int32
	const pages = 200
	fetch := func(_ context.Context, cursor string) (*output.Page, error) {
		n := int(fetched.Add(1))
		var items []json.RawMessage
		for i := 0; i < 100; i++ {
			items = append(items, json.RawMessage(fmt.Sprintf(`{"name":"document %d-%d with a long enough name","id":"ID%05d%03d","status":"ready"}`, n, i, n, i)))
		}
		next := ""
		if n < pages {
			next = fmt.Sprint(n)
		}
		return &output.Page{Items: items, Next: next}, nil
	}
	u := ui.Setup(tm.f.IO, ui.Settings{Theme: "dark"})
	p, err := output.New(tm.f, u)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.List(context.Background(), fetch, output.ListOptions{Noun: "documents"}); err != nil {
		t.Fatalf("quitting the pager is not an error: %v", err)
	}
	if got := fetched.Load(); got >= pages/2 {
		t.Fatalf("fetched %d of %d pages after the pager quit at 30 lines", got, pages)
	}
	if got := tm.recorded(t); strings.Count(got, "\n") != 31 {
		t.Errorf("the pager read %d lines", strings.Count(got, "\n"))
	}
}

func TestMorePrompt(t *testing.T) {
	for in, want := range map[string][2]bool{"\n": {true, false}, "a\n": {true, true}, "q\n": {false, false}, "": {false, false}} {
		tm := newTerm(t)
		tm.f.IO.In = strings.NewReader(in)
		more, all := MorePrompt(tm.f, 50)
		if more != want[0] || all != want[1] {
			t.Errorf("%q: more %v all %v", in, more, all)
		}
		if !strings.Contains(tm.err.String(), "50 shown") || !strings.Contains(tm.err.String(), "Enter for more, a for all, q to stop") || !strings.HasSuffix(tm.err.String(), "\r\x1b[K") {
			t.Errorf("prompt %q", tm.err.String())
		}
	}
	tm := newTerm(t)
	dir := filepath.Join(tm.f.Home, ".caitlyn")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "config"), []byte("paging = \"off\"\n"), 0o600)
	tm.f.IO.In = strings.NewReader("a\n")
	if more, _ := MorePrompt(tm.f, 50); more || tm.err.Len() != 0 {
		t.Error("paging = off: no prompt")
	}
}

// Without a pager, a list on a terminal shows a page, asks, and carries on.
func TestListMore(t *testing.T) {
	Install()
	tm := newTerm(t, "CAITLYN_PAGER=")
	tm.f.IO.In = strings.NewReader("\nq\n")
	var fetched int
	fetch := func(_ context.Context, cursor string) (*output.Page, error) {
		fetched++
		return &output.Page{Items: []json.RawMessage{json.RawMessage(fmt.Sprintf(`{"name":"n%d","id":"I%d"}`, fetched, fetched))}, Next: "more"}, nil
	}
	p, _ := output.New(tm.f, ui.Setup(tm.f.IO, ui.Settings{Theme: "dark"}))
	if err := p.List(context.Background(), fetch, output.ListOptions{}); err != nil {
		t.Fatal(err)
	}
	if fetched != 2 || strings.Count(tm.err.String(), "shown") != 2 {
		t.Errorf("fetched %d, prompts %q", fetched, tm.err.String())
	}
}
