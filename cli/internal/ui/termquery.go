package ui

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"golang.org/x/term"

	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

// QueryLimit is how long the CLI waits for a terminal to answer a query: the background colour (12.3), image
// support and the cell size (19.2).
const QueryLimit = 100 * time.Millisecond

// DA1 is the primary device attributes request. Every terminal answers it, so sending it after another query means
// the read ends as soon as the terminal has said all it will, rather than at the time limit.
const DA1 = "\x1b[c"

// Querier asks the terminal something and reads its reply.
type Querier interface {
	// Query writes q, then reads until done reports the reply complete or limit passes, and returns what it read.
	Query(q string, done func(reply []byte) bool, limit time.Duration) []byte
}

// SystemQuerier returns a Querier for the process's terminal, or nil when the CLI mustn't ask: stdin isn't the
// terminal (a reply would be read from someone else's input), neither output is a terminal, or TERM is dumb.
func SystemQuerier(io *iostreams.IOStreams) Querier {
	if !io.IsStdinTTY() || io.Getenv("TERM") == "dumb" {
		return nil
	}
	in, ok := io.In.(*os.File)
	if !ok {
		return nil
	}
	var out *os.File
	switch {
	case io.IsStderrTTY():
		out, _ = io.ErrOut.(*os.File)
	case io.IsStdoutTTY():
		out, _ = io.Out.(*os.File)
	}
	if out == nil {
		return nil
	}
	return &ttyQuerier{in: in, out: out}
}

type ttyQuerier struct{ in, out *os.File }

func (t *ttyQuerier) Query(q string, done func([]byte) bool, limit time.Duration) []byte {
	state, err := term.MakeRaw(int(t.in.Fd()))
	if err != nil {
		return nil
	}
	defer func() { _ = term.Restore(int(t.in.Fd()), state) }()
	rd, err := uv.NewCancelReader(t.in)
	if err != nil {
		return nil
	}
	defer rd.Close()
	timer := time.AfterFunc(limit, func() { rd.Cancel() })
	defer timer.Stop()
	if _, err := t.out.WriteString(q); err != nil {
		return nil
	}
	var acc []byte
	buf := make([]byte, 256)
	for {
		n, err := rd.Read(buf)
		acc = append(acc, buf[:n]...)
		if err != nil || done(acc) {
			return acc
		}
	}
}

// HasDA1 reports whether a reply includes the answer to DA1 (CSI ? … c).
func HasDA1(reply []byte) bool { return da1Reply.Match(reply) }

var (
	da1Reply  = regexp.MustCompile(`\x1b\[\?[0-9;]*c`)
	osc11     = regexp.MustCompile(`\x1b\]11;rgba?:([0-9a-fA-F]{1,4})/([0-9a-fA-F]{1,4})/([0-9a-fA-F]{1,4})`)
	osc11Ask  = "\x1b]11;?\x07"
	lumaLimit = 0.5
)

// QueryBackground asks the terminal for its background colour (OSC 11, then DA1 so the read ends early on terminals
// that don't answer it), and returns "dark", "light", or "" when the terminal didn't say within QueryLimit.
func QueryBackground(q Querier) string {
	if q == nil {
		return ""
	}
	return BackgroundFromReply(q.Query(osc11Ask+DA1, HasDA1, QueryLimit))
}

// BackgroundFromReply reads an OSC 11 reply ("rgb:RRRR/GGGG/BBBB"): dark below half luminance, otherwise light.
func BackgroundFromReply(reply []byte) string {
	m := osc11.FindSubmatch(reply)
	if m == nil {
		return ""
	}
	var c [3]float64
	for i := range c {
		h := string(m[i+1])
		v, err := strconv.ParseUint(h, 16, 32)
		if err != nil {
			return ""
		}
		c[i] = float64(v) / float64(uint64(1)<<(4*len(h))-1)
	}
	if 0.2126*c[0]+0.7152*c[1]+0.0722*c[2] < lumaLimit {
		return "dark"
	}
	return "light"
}

// InMultiplexer reports whether the CLI runs inside tmux or screen, which pass terminal queries and image sequences
// through unreliably (19.1).
func InMultiplexer(getenv func(string) string) bool {
	t := getenv("TERM")
	return getenv("TMUX") != "" || getenv("STY") != "" || strings.HasPrefix(t, "screen") || strings.HasPrefix(t, "tmux")
}
