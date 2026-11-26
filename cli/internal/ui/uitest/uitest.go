// Package uitest renders the design system through fake terminals for golden (snapshot) tests (the CLI design,
// 17.2): five colour profiles at three widths, compared with committed files that keep the escape sequences.
// Run the tests with -update to rewrite the files after a deliberate change; the diff is then the review.
package uitest

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// Update rewrites golden files instead of comparing with them.
var Update = flag.Bool("update", false, "rewrite golden files")

// Profile is a fake terminal's colour set-up.
type Profile struct {
	Name     string
	Env      []string
	Settings ui.Settings
}

// Profiles are the five the snapshots are rendered at: truecolour on a dark and a light background, 256 colours,
// 16 colours, and no colour with ASCII glyphs.
var Profiles = []Profile{
	{"truecolor-dark", []string{"TERM=xterm-256color", "COLORTERM=truecolor", "LANG=en_NZ.UTF-8", "VTE_VERSION=7600"}, ui.Settings{Theme: "dark"}},
	{"truecolor-light", []string{"TERM=xterm-256color", "COLORTERM=truecolor", "LANG=en_NZ.UTF-8", "VTE_VERSION=7600"}, ui.Settings{Theme: "light"}},
	{"ansi256", []string{"TERM=xterm-256color", "LANG=en_NZ.UTF-8"}, ui.Settings{Theme: "dark"}},
	{"ansi", []string{"TERM=xterm", "LANG=en_NZ.UTF-8"}, ui.Settings{Theme: "dark"}},
	{"nocolor-ascii", []string{"TERM=xterm", "LANG=C", "NO_COLOR=1"}, ui.Settings{Theme: "dark", Glyphs: "ascii"}},
}

// Widths are the terminal widths the snapshots are rendered at.
var Widths = []int{40, 80, 120}

// Term is a fake terminal: stdin, stdout and stderr all terminals, at a width.
type Term struct {
	IO       *iostreams.IOStreams
	Out, Err *bytes.Buffer
	F        *cmdutil.Factory
	U        *ui.UI
}

// New makes a fake terminal for a profile and width, with an empty configuration in a temporary home.
func New(t testing.TB, p Profile, width int, extraEnv ...string) *Term {
	t.Helper()
	io, out, errOut := iostreams.Test("")
	io.SetTTY(true, true, true)
	io.SetWidth(width)
	io.Decorate = true
	io.Environ = append(append([]string{}, p.Env...), extraEnv...)
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Home: t.TempDir(), WorkDir: t.TempDir()}
	return &Term{IO: io, Out: out, Err: errOut, F: f, U: ui.Setup(io, p.Settings)}
}

// Golden compares a terminal's stdout and stderr with testdata/golden/<name>.golden, or rewrites it with -update.
func (tm *Term) Golden(t testing.TB, name string) {
	t.Helper()
	got := fmt.Sprintf("-- stdout --\n%s-- stderr --\n%s", tm.Out.String(), tm.Err.String())
	Compare(t, name, []byte(got))
}

// Compare compares bytes with testdata/golden/<name>.golden.
func Compare(t testing.TB, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", "golden", name+".golden")
	if *Update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v (run the tests with -update to create it)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from the golden file (run with -update after a deliberate change)\n got: %q\nwant: %q", path, got, want)
	}
}

// Each runs fn for every profile and width, as a subtest named <profile>-<width>.
func Each(t *testing.T, fn func(t *testing.T, p Profile, width int)) {
	for _, p := range Profiles {
		for _, w := range Widths {
			t.Run(fmt.Sprintf("%s-%d", p.Name, w), func(t *testing.T) { fn(t, p, w) })
		}
	}
}
