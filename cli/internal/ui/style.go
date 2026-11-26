package ui

import (
	"fmt"
	"image/color"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"
)

// Profile is a stream's colour depth.
type Profile string

// The depths.
const (
	NoColor   Profile = ""
	ANSI      Profile = "ansi"
	ANSI256   Profile = "ansi256"
	TrueColor Profile = "truecolor"
)

// ColorChoice is what decides whether a stream is coloured (12.3), first match wins:
//
//  1. --color always|never|auto (--no-color is never);
//  2. CAITLYN_COLOR;
//  3. color in configuration, when set;
//  4. NO_COLOR (set and not empty): never;
//  5. FORCE_COLOR (not 0), then CLICOLOR_FORCE (not 0): always;
//  6. CLICOLOR=0: never;
//  7. auto: colour when the stream is a terminal and TERM isn't dumb, and in a CI log that renders ANSI.
type ColorChoice struct {
	Flag, Config string
	Getenv       func(string) string
	// CIANSI: the CI provider's log renders 16-colour ANSI.
	CIANSI bool
}

// Decide returns whether a stream is coloured, and the rule that decided.
func (c ColorChoice) Decide(isTTY bool) (bool, string) {
	choose := func(v, rule string) (bool, string, bool) {
		switch strings.ToLower(v) {
		case "always", "yes", "true", "1", "force":
			return true, rule, true
		case "never", "no", "false", "0", "off":
			return false, rule, true
		case "auto", "":
			return false, "", false
		}
		return false, "", false
	}
	if on, r, ok := choose(c.Flag, "--color"); ok {
		return on, r
	}
	if on, r, ok := choose(c.Getenv("CAITLYN_COLOR"), "CAITLYN_COLOR"); ok {
		return on, r
	}
	if on, r, ok := choose(c.Config, "color in configuration"); ok {
		return on, r
	}
	if c.Getenv("NO_COLOR") != "" {
		return false, "NO_COLOR"
	}
	if v := c.Getenv("FORCE_COLOR"); v != "" && v != "0" {
		return true, "FORCE_COLOR"
	}
	if v := c.Getenv("CLICOLOR_FORCE"); v != "" && v != "0" {
		return true, "CLICOLOR_FORCE"
	}
	if c.Getenv("CLICOLOR") == "0" {
		return false, "CLICOLOR=0"
	}
	if c.Getenv("TERM") == "dumb" {
		return false, "TERM=dumb"
	}
	if isTTY {
		return true, "a terminal"
	}
	if c.CIANSI {
		return true, "a CI log that shows colour"
	}
	return false, "not a terminal"
}

// DetectProfile reads the colour depth from the environment, with colorprofile (12.3). Whether a stream is coloured
// at all is ColorChoice's decision, so the switches colorprofile also reads (NO_COLOR, CLICOLOR, CLICOLOR_FORCE) are
// left out here; this answers only "how many colours". A few terminals colorprofile can't tell from TERM alone
// (iTerm2, WezTerm, Ghostty, VS Code, Windows Terminal) are known to show truecolour. In CI logs only the 16 colours
// are used (15.2).
func DetectProfile(getenv func(string) string, ci bool) Profile {
	if ci {
		return ANSI
	}
	var env []string
	for _, k := range []string{"TERM", "COLORTERM", "GOOGLE_CLOUD_SHELL", "TMUX"} {
		if v := getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	p := colorprofile.Env(env)
	switch getenv("TERM_PROGRAM") {
	case "iTerm.app", "WezTerm", "ghostty", "vscode":
		p = max(p, colorprofile.TrueColor)
	}
	if getenv("WT_SESSION") != "" {
		p = max(p, colorprofile.TrueColor)
	}
	if strings.Contains(getenv("TERM"), "256color") || getenv("TERM") == "xterm-kitty" {
		p = max(p, colorprofile.ANSI256)
	}
	switch {
	case p >= colorprofile.TrueColor:
		return TrueColor
	case p == colorprofile.ANSI256:
		return ANSI256
	}
	return ANSI
}

// BackgroundFromEnv reads COLORFGBG ("15;0": light text on a dark background). "" when it says nothing.
func BackgroundFromEnv(getenv func(string) string) string {
	v := getenv("COLORFGBG")
	if v == "" {
		return ""
	}
	parts := strings.Split(v, ";")
	bg, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		return ""
	}
	if bg == 7 || bg >= 9 && bg <= 15 {
		return "light"
	}
	return "dark"
}

// ANSIStyler paints roles with escape sequences at one depth, for one background (12.3).
type ANSIStyler struct {
	Profile Profile
	// Background is dark, light or "" (unknown: treated as dark for greys, and the headline falls back to bold).
	Background string
	// Accessible restricts every role to the 16-colour palette (accessible_colors).
	Accessible bool
	// Mono keeps bold and drops every colour (theme = mono).
	Mono bool
	// Links: the terminal shows OSC 8 hyperlinks.
	Links bool
}

// paint is one role's look: bold, underline and a foreground colour (nil for the terminal's own).
type paint struct {
	bold, underline, italic bool
	fg                      color.Color
}

// render draws s with lipgloss. Each line is styled on its own, so a multi-line value never leaves colour open
// across a line break.
func (p paint) render(s string) string {
	if s == "" || (!p.bold && !p.underline && !p.italic && p.fg == nil) {
		return s
	}
	if p.underline {
		// lipgloss styles each space of underlined text separately; one plain SGR is what links need
		st := ansi.Style{}.Underline(true)
		if p.bold {
			st = st.Bold()
		}
		if p.fg != nil {
			st = st.ForegroundColor(p.fg)
		}
		lines := strings.Split(s, "\n")
		for i, l := range lines {
			if l != "" {
				lines[i] = st.Styled(l)
			}
		}
		return strings.Join(lines, "\n")
	}
	st := lipgloss.NewStyle().Bold(p.bold).Italic(p.italic).TabWidth(lipgloss.NoTabConversion)
	if p.fg != nil {
		st = st.Foreground(p.fg)
	}
	return st.Render(s)
}

// The 16-colour palette, by role (12.3): the terminal's own colours, so its theme decides.
var (
	ansiBrightBlack  = ansi.BrightBlack
	ansiBrightYellow = ansi.BrightYellow
	ansiGreen        = ansi.Green
	ansiRed          = ansi.Red
	ansiYellow       = ansi.Yellow
)

// rgb gives a foreground colour at the styler's depth, from a brand hex value and its xterm-256 index. On 16 colours
// brand values aren't approximated: the role's 16-colour entry is used (12.3).
func (a ANSIStyler) rgb(r, g, b uint8, idx256 int, ansi16 color.Color) color.Color {
	if a.Mono {
		return nil
	}
	if a.Accessible || a.Profile == ANSI {
		return ansi16
	}
	if a.Profile == ANSI256 {
		return ansi.IndexedColor(idx256)
	}
	return lipgloss.Color(fmt.Sprintf("#%02x%02x%02x", r, g, b))
}

// look is the paint for a role.
func (a ANSIStyler) look(r Role) paint {
	light := a.Background == "light"
	switch r {
	case Strong:
		return paint{bold: true}
	case Muted:
		if light {
			return paint{fg: a.rgb(0x66, 0x74, 0x70, 243, ansiBrightBlack)}
		}
		return paint{fg: a.rgb(0xa8, 0xb0, 0xad, 248, ansiBrightBlack)}
	case Rule:
		if light {
			return paint{fg: a.rgb(0xd9, 0xd5, 0xd3, 253, ansiBrightBlack)}
		}
		return paint{fg: a.rgb(0x2e, 0x33, 0x31, 236, ansiBrightBlack)}
	case Accent:
		// Amber is never text on a light background (12.2): bold instead
		if light || a.Background == "" || a.Mono {
			return paint{bold: true}
		}
		return paint{fg: a.rgb(0xff, 0xbb, 0x26, 214, ansiBrightYellow)}
	case Marker:
		if light || a.Background == "" || a.Mono {
			return paint{bold: true}
		}
		return paint{fg: a.rgb(0xff, 0x92, 0x07, 208, ansiBrightYellow)}
	case Headline:
		// The emblem screens' headline (12.2, question 31): brand yellow on dark; bold ink on light where the terminal
		// can show it; plain bold in 16 colours, mono, or when the background is unknown.
		switch {
		case a.Mono || a.Background == "" || a.Profile == ANSI || a.Accessible:
			if a.Background == "dark" && !a.Mono && (a.Profile == ANSI || a.Accessible) {
				return paint{fg: ansiBrightYellow}
			}
			return paint{bold: true}
		case light:
			return paint{bold: true, fg: a.rgb(0x0a, 0x0c, 0x0b, 232, nil)}
		default:
			return paint{fg: a.rgb(0xff, 0xbb, 0x26, 214, ansiBrightYellow)}
		}
	case Success, Added:
		return paint{fg: a.mono(ansiGreen)}
	case Error, Removed:
		return paint{fg: a.mono(ansiRed)}
	case Warning, Changed:
		return paint{fg: a.mono(ansiYellow)}
	case Link:
		return paint{underline: true}
	case Quote:
		return paint{italic: true}
	}
	return paint{}
}

// Paint styles s in role r.
func (a ANSIStyler) Paint(r Role, s string) string {
	if a.Profile == NoColor {
		return s
	}
	return a.look(r).render(s)
}

// Colourful reports whether the styler shows colour (not mono, not plain).
func (a ANSIStyler) Colourful() bool { return a.Profile != NoColor && !a.Mono }

func (a ANSIStyler) mono(c color.Color) color.Color {
	if a.Mono {
		return nil
	}
	return c
}

// Colourful reports whether a styler shows colour, so a component can add text markers where colour would otherwise
// carry meaning alone (diffs without colour use [-removed-] and {+added+}).
func Colourful(s Styler) bool {
	c, ok := s.(interface{ Colourful() bool })
	return ok && c.Colourful()
}

// Hyperlink writes an OSC 8 link where the terminal supports it, underlined.
func (a ANSIStyler) Hyperlink(url, text string) string {
	if text == "" {
		text = url
	}
	if a.Profile == NoColor || !a.Links {
		if text == url {
			return url
		}
		return text + " " + url
	}
	return "\x1b]8;;" + url + "\x1b\\" + a.Paint(Link, text) + "\x1b]8;;\x1b\\"
}
