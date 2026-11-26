// Package pager pages long output on a terminal (the CLI design, section 14). The pager is $CAITLYN_PAGER, then
// $PAGER, then `pager` in configuration, then `less -FRX`; LESS=FRX is set for it when LESS isn't. Output is written
// into the pager's input as it is produced, so a list fetches its next page only when the person scrolls to it, and
// quitting the pager stops the fetching with exit code 0. Without a pager, a list offers "more" instead.
package pager

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/term"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/shellwords"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// Default is the pager when none is configured.
const Default = "less -FRX"

// Command is the pager to run and whether a person chose it ($CAITLYN_PAGER, $PAGER or `pager` in a file), as
// opposed to the built-in default. An empty command, or cat, means no pager.
func Command(f *cmdutil.Factory) (string, bool) {
	for _, k := range []string{"CAITLYN_PAGER", "PAGER"} {
		if v, ok := f.IO.LookupEnv(k); ok {
			return strings.TrimSpace(v), true
		}
	}
	if cfg, err := f.Config(); err == nil && cfg != nil {
		if v := cfg.Get("pager"); v.Set && v.Origin != "default" && v.Origin != "env" {
			return strings.TrimSpace(v.Value), true
		}
	}
	return Default, false
}

// GOOS is the operating system, for tests of the Windows rule.
var GOOS = runtime.GOOS

// Why says why output isn't paged, or "" when it may be (14.1).
func Why(f *cmdutil.Factory) string {
	cmd, configured := Command(f)
	switch {
	case f.Globals != nil && f.Globals.NoPager:
		return "--no-pager"
	case cmd == "" || cmd == "cat":
		return "no pager configured"
	case !f.IO.IsStdoutTTY():
		return "stdout isn't a terminal"
	case f.CI.In():
		return "CI"
	case f.Agent.On:
		return "agent mode"
	case !f.IO.Decorate:
		return "no decoration"
	case GOOS == "windows" && !configured:
		return "Windows has no pager by default"
	}
	if format, err := output.Resolve(f); err == nil && (format == output.JSON || format == output.JSONL) {
		return "JSON output on a terminal is for copying"
	}
	return ""
}

type running struct {
	cmd  *exec.Cmd
	orig io.Writer
}

var (
	mu      sync.Mutex
	current = map[*cmdutil.Factory]*running{}
)

// Start runs the pager and sends stdout into it until Stop. It reports false, and changes nothing, when output
// isn't paged (Why) or the pager can't be started.
func Start(f *cmdutil.Factory) bool {
	if Why(f) != "" {
		return false
	}
	mu.Lock()
	defer mu.Unlock()
	if current[f] != nil {
		return true
	}
	line, _ := Command(f)
	pr, pw, err := os.Pipe()
	if err != nil {
		return false
	}
	c := shellCommand(line)
	if c == nil {
		pr.Close()
		pw.Close()
		return false
	}
	c.Stdin = pr
	c.Stdout = f.IO.Out
	c.Stderr = f.IO.ErrOut
	c.Env = Environ(f.IO.Environ)
	if err := c.Start(); err != nil {
		pr.Close()
		pw.Close()
		return false
	}
	pr.Close()
	current[f] = &running{cmd: c, orig: f.IO.Out}
	f.IO.SetPager(pw, pw)
	return true
}

// Stop closes the pager's input and waits for the person to quit it, then puts stdout back.
func Stop(f *cmdutil.Factory) {
	mu.Lock()
	r := current[f]
	delete(current, f)
	mu.Unlock()
	if r == nil {
		return
	}
	_ = f.IO.ClosePager()
	_ = r.cmd.Wait()
	f.IO.Out = r.orig
}

// Environ is the pager's environment: the CLI's, with LESS=FRX when LESS isn't set (as git does) and LV=-c for lv.
func Environ(env []string) []string {
	out := append([]string(nil), env...)
	has := func(k string) bool {
		for _, e := range env {
			if strings.HasPrefix(e, k+"=") {
				return true
			}
		}
		return false
	}
	if !has("LESS") {
		out = append(out, "LESS=FRX")
	}
	if !has("LV") {
		out = append(out, "LV=-c")
	}
	return out
}

func shellCommand(line string) *exec.Cmd {
	if GOOS == "windows" {
		parts := shellwords.Split(line)
		if len(parts) == 0 {
			return nil
		}
		return exec.Command(parts[0], parts[1:]...)
	}
	return exec.Command("sh", "-c", line)
}

// Page writes text, through the pager when it is longer than the screen (help, detail views, diffs, config list).
func Page(f *cmdutil.Factory, text string) error {
	if strings.Count(text, "\n") >= Height(f) && Start(f) {
		_, err := io.WriteString(f.IO.Out, text)
		Stop(f)
		if err != nil && isClosed(err) {
			return nil
		}
		return err
	}
	_, err := io.WriteString(f.IO.Out, text)
	return err
}

func isClosed(err error) bool {
	return strings.Contains(err.Error(), "broken pipe") || strings.Contains(err.Error(), "closed pipe")
}

// Height is the terminal's height in rows: stdout's size, then LINES, then 24.
func Height(f *cmdutil.Factory) int {
	if o, ok := f.IO.Out.(*os.File); ok {
		if _, h, err := term.GetSize(int(o.Fd())); err == nil && h > 0 {
			return h
		}
	}
	if n, err := strconv.Atoi(f.IO.Getenv("LINES")); err == nil && n > 0 {
		return n
	}
	return 24
}

// MorePrompt asks, on stderr, whether to show more of a list (14.3): Enter for the next page, a for all, q to stop.
// With `paging = off` it doesn't ask, and the list prints its --cursor hint instead.
func MorePrompt(f *cmdutil.Factory, shown int) (more, all bool) {
	if cfg, err := f.Config(); err == nil && cfg != nil && strings.EqualFold(cfg.String("paging"), "off") {
		return false, false
	}
	u := ui.New(f.IO)
	if uu := uiFor(f); uu != nil {
		u = uu
	}
	g := u.G
	line := fmt.Sprintf("%s %d shown %s Enter for more, a for all, q to stop %s", strings.Repeat(g.Rule, 2), shown, g.Dot, strings.Repeat(g.Rule, 2))
	fmt.Fprint(f.IO.ErrOut, u.E(ui.Muted, line))
	key := readKey(f)
	fmt.Fprint(f.IO.ErrOut, "\r\x1b[K")
	switch key {
	case 'a', 'A':
		return true, true
	case '\r', '\n', ' ', 'j', 'f':
		return true, false
	}
	return false, false
}

// uiFor is the run's UI; the commands package sets it to gen.UIFor.
var uiFor = func(*cmdutil.Factory) *ui.UI { return nil }

// SetUI tells the pager how to find the run's UI.
func SetUI(fn func(*cmdutil.Factory) *ui.UI) { uiFor = fn }

// readKey reads one key from the terminal (raw mode), or the first character of a line when stdin isn't a file.
func readKey(f *cmdutil.Factory) byte {
	if in, ok := f.IO.In.(*os.File); ok && term.IsTerminal(int(in.Fd())) {
		state, err := term.MakeRaw(int(in.Fd()))
		if err == nil {
			defer func() { _ = term.Restore(int(in.Fd()), state) }()
			var b [1]byte
			if n, _ := in.Read(b[:]); n == 1 {
				return b[0]
			}
			return 'q'
		}
	}
	s, err := bufio.NewReader(f.IO.In).ReadString('\n')
	if err != nil && s == "" {
		return 'q'
	}
	s = strings.TrimRight(s, "\r\n")
	if s == "" {
		return '\n'
	}
	return s[0]
}

// Install fills output.PagerHooks.
func Install() {
	output.PagerHooks.Start = Start
	output.PagerHooks.Stop = Stop
	output.PagerHooks.MorePrompt = MorePrompt
}
