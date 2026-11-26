// Package ui is the CLI's terminal design system (the CLI design, section 12): semantic roles instead of colours,
// glyphs with ASCII fallbacks, and the few components every command draws with (tables, detail views, success and
// error blocks, diffs, spinners, progress, prompts). No command styles its own output.
//
// Colour and glyph decisions are made once, from the streams, configuration and environment, by Setup.
package ui

import (
	"fmt"
	"io"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

// Role is a semantic style (12.3).
type Role int

// The roles.
const (
	Default Role = iota
	Strong
	Muted
	Rule
	Accent
	Success
	Error
	Warning
	Added
	Removed
	Changed
	Link
	// Headline is the first line beside the emblem: the brand yellow on dark backgrounds, bold ink on light ones.
	Headline
	// Marker is the accent as small text: the › before an agent's name, citation numbers.
	Marker
	// Quote is quoted text: citations' passages, and an agent's own words quoted inside a diff. Italic, and never the
	// only marker of anything (12.4).
	Quote
)

// Glyphs are the symbols in use: Unicode, or ASCII without a UTF-8 locale, with TERM=dumb, or glyphs = ascii (12.5).
type Glyphs struct {
	Success, Failure, Warning, Next, Marker, Bullet, Waiting, Rule, Ellipsis, Dot string
	// Active marks something running in a stream of events: ● (12.10, events tail).
	Active             string
	Branch, Last, Pipe string
	Spinner            []string
	Unicode            bool
}

// UnicodeGlyphs and ASCIIGlyphs are the two sets.
var (
	UnicodeGlyphs = Glyphs{Success: "✓", Failure: "✗", Warning: "!", Next: "→", Marker: "›", Bullet: "•", Waiting: "○",
		Rule: "─", Ellipsis: "…", Dot: "·", Active: "●", Branch: "├─", Last: "└─", Pipe: "│",
		Spinner: []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}, Unicode: true}
	ASCIIGlyphs = Glyphs{Success: "+", Failure: "x", Warning: "!", Next: "->", Marker: ">", Bullet: "*", Waiting: "o",
		Rule: "-", Ellipsis: "...", Dot: "-", Active: "*", Branch: "+-", Last: `\-`, Pipe: "|",
		Spinner: []string{"-", `\`, "|", "/"}}
)

// Styler paints text in a role for one stream.
type Styler interface {
	Paint(r Role, s string) string
	Hyperlink(url, text string) string
}

// UI draws on a command's streams.
type UI struct {
	IO  *iostreams.IOStreams
	G   Glyphs
	Out Styler
	Err Styler
	// Background is "dark", "light" or "" (unknown).
	Background string
}

// plain paints nothing.
type plain struct{}

func (plain) Paint(_ Role, s string) string { return s }
func (plain) Hyperlink(url, text string) string {
	if text == "" || text == url {
		return url
	}
	return text + " " + url
}

// New returns a UI with no colour and the glyphs the environment allows. Setup replaces the stylers.
func New(io *iostreams.IOStreams) *UI {
	u := &UI{IO: io, G: ASCIIGlyphs, Out: plain{}, Err: plain{}}
	if UTF8(io.Getenv) && io.Getenv("TERM") != "dumb" {
		u.G = UnicodeGlyphs
	}
	return u
}

// UTF8 reports whether the locale is UTF-8 (LC_ALL, then LC_CTYPE, then LANG).
func UTF8(getenv func(string) string) bool {
	for _, k := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		if v := getenv(k); v != "" {
			v = strings.ToLower(v)
			return strings.Contains(v, "utf-8") || strings.Contains(v, "utf8")
		}
	}
	// macOS and most terminals are UTF-8 with no locale variables set; Windows Terminal too
	return getenv("TERM_PROGRAM") != "" || getenv("WT_SESSION") != ""
}

// S paints for stdout.
func (u *UI) S(r Role, s string) string { return u.Out.Paint(r, s) }

// E paints for stderr.
func (u *UI) E(r Role, s string) string { return u.Err.Paint(r, s) }

// Successf prints a success line on stderr: ✓ and a sentence in the past tense (12.9).
func (u *UI) Successf(format string, args ...any) {
	fmt.Fprintf(u.IO.ErrOut, "%s %s\n", u.E(Success, u.G.Success), fmt.Sprintf(format, args...))
}

// Warnf prints a warning on stderr.
func (u *UI) Warnf(format string, args ...any) {
	fmt.Fprintf(u.IO.ErrOut, "%s %s\n", u.E(Warning, u.G.Warning), fmt.Sprintf(format, args...))
}

// Nextf prints the one obvious next command on stderr, muted, after an arrow.
func (u *UI) Nextf(format string, args ...any) {
	fmt.Fprintf(u.IO.ErrOut, "%s %s\n", u.E(Muted, u.G.Next), u.E(Muted, fmt.Sprintf(format, args...)))
}

// Infof prints a muted line on stderr.
func (u *UI) Infof(format string, args ...any) {
	fmt.Fprintln(u.IO.ErrOut, u.E(Muted, fmt.Sprintf(format, args...)))
}

// Truncate shortens s to width display cells with an ellipsis.
func (u *UI) Truncate(s string, width int) string {
	if width <= 0 || DisplayWidth(s) <= width {
		return s
	}
	ell := u.G.Ellipsis
	w := width - DisplayWidth(ell)
	if w <= 0 {
		return ell[:min(len(ell), width)]
	}
	var b strings.Builder
	n := 0
	for _, r := range s {
		rw := runeWidth(r)
		if n+rw > w {
			break
		}
		b.WriteRune(r)
		n += rw
	}
	return b.String() + ell
}

// Writer is where data goes: stdout.
func (u *UI) Writer() io.Writer { return u.IO.Out }
