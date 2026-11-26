// Package iostreams is where the CLI's input and output go, and what each stream is: a terminal or not, its width,
// and whether colour, spinners and prompts are allowed there. Every command writes through it, so tests run every
// command against fake terminals (Test), and no command decides for itself whether it is talking to a person.
package iostreams

import (
	"bytes"
	"io"
	"os"
	"strconv"
	"sync"

	"golang.org/x/term"
)

// IOStreams are a command's standard streams and what they are connected to.
type IOStreams struct {
	In     io.Reader
	Out    io.Writer
	ErrOut io.Writer

	// Environ is the process environment as KEY=value pairs; tests set their own.
	Environ []string

	inTTY, outTTY, errTTY bool
	width                 int
	// ColorOut and ColorErr say whether colour is used on stdout and stderr, decided once by the root command
	// (12.3's order of switches). Data on stdout is never coloured when stdout is not a terminal.
	ColorOut, ColorErr bool
	// Profile is the colour depth in use: "truecolor", "ansi256", "ansi" or "" (no colour).
	ProfileOut, ProfileErr string

	// NeverPrompt is set in CI, in agent mode and with --no-input: anything that would ask exits 3 instead.
	NeverPrompt bool
	// Decorate is false in CI and agent mode: no spinners, progress bars, emblem or pager.
	Decorate bool

	mu       sync.Mutex
	pagerOut io.WriteCloser
}

// System returns the process's own streams.
func System() *IOStreams {
	s := &IOStreams{In: os.Stdin, Out: os.Stdout, ErrOut: os.Stderr, Environ: os.Environ(), Decorate: true}
	s.inTTY = isTerminal(os.Stdin)
	s.outTTY = isTerminal(os.Stdout)
	s.errTTY = isTerminal(os.Stderr)
	if v := s.Getenv("CAITLYN_FORCE_TTY"); v != "" && v != "0" {
		// For screenshots and recordings: treat stdout as a terminal of this width (a number) or the default width
		s.outTTY = true
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			s.width = n
		}
	}
	return s
}

func isTerminal(f *os.File) bool {
	return term.IsTerminal(int(f.Fd()))
}

// Test returns streams backed by buffers: stdin from in, and stdout and stderr captured. They are not terminals
// unless SetTTY says so.
func Test(in string) (*IOStreams, *bytes.Buffer, *bytes.Buffer) {
	out, errOut := &bytes.Buffer{}, &bytes.Buffer{}
	return &IOStreams{In: bytes.NewBufferString(in), Out: out, ErrOut: errOut, Environ: []string{}, width: 80}, out, errOut
}

// SetTTY marks the streams as terminals (for tests).
func (s *IOStreams) SetTTY(in, out, err bool) { s.inTTY, s.outTTY, s.errTTY = in, out, err }

// SetWidth sets the terminal width (for tests).
func (s *IOStreams) SetWidth(w int) { s.width = w }

// IsStdinTTY reports whether stdin is a terminal.
func (s *IOStreams) IsStdinTTY() bool { return s.inTTY }

// IsStdoutTTY reports whether stdout is a terminal.
func (s *IOStreams) IsStdoutTTY() bool { return s.outTTY }

// IsStderrTTY reports whether stderr is a terminal.
func (s *IOStreams) IsStderrTTY() bool { return s.errTTY }

// CanPrompt reports whether the CLI may ask a question: stdin and stderr are terminals, and nothing forbids it.
func (s *IOStreams) CanPrompt() bool { return !s.NeverPrompt && s.inTTY && s.errTTY }

// Width is the terminal's width in columns (80 when it can't be read; stdout's, else stderr's).
func (s *IOStreams) Width() int {
	if s.width > 0 {
		return s.width
	}
	for _, f := range []*os.File{os.Stdout, os.Stderr} {
		if w, _, err := term.GetSize(int(f.Fd())); err == nil && w > 0 {
			return w
		}
	}
	if v, err := strconv.Atoi(s.Getenv("COLUMNS")); err == nil && v > 0 {
		return v
	}
	return 80
}

// ProseWidth is where prose wraps: the smaller of the terminal width and 100 columns (12.4).
func (s *IOStreams) ProseWidth() int { return min(s.Width(), 100) }

// Getenv reads the environment the streams were made with.
func (s *IOStreams) Getenv(key string) string {
	v, _ := s.LookupEnv(key)
	return v
}

// LookupEnv reads the environment the streams were made with, reporting whether the variable is set.
func (s *IOStreams) LookupEnv(key string) (string, bool) {
	prefix := key + "="
	for i := len(s.Environ) - 1; i >= 0; i-- {
		if len(s.Environ[i]) >= len(prefix) && s.Environ[i][:len(prefix)] == prefix {
			return s.Environ[i][len(prefix):], true
		}
	}
	return "", false
}

// Setenv sets a variable in the streams' environment (tests, and CAITLYN_* defaults the root command fills in).
func (s *IOStreams) Setenv(key, value string) {
	s.Environ = append(s.Environ, key+"="+value)
}

// SetPager redirects Out to a running pager's input until ClosePager. See package pager.
func (s *IOStreams) SetPager(w io.WriteCloser, out io.Writer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pagerOut = w
	s.Out = out
}

// ClosePager closes the pager's input, if one is running, and returns where Out went before it.
func (s *IOStreams) ClosePager() error {
	s.mu.Lock()
	w := s.pagerOut
	s.pagerOut = nil
	s.mu.Unlock()
	if w == nil {
		return nil
	}
	return w.Close()
}
