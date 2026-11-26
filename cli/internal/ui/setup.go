package ui

import (
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

// Settings are what Setup reads besides the environment.
type Settings struct {
	ColorFlag   string // --color, or "never" for --no-color
	ColorConfig string // color in configuration
	Theme       string // auto, dark, light or mono
	Glyphs      string // unicode or ascii
	Accessible  bool   // accessible_colors
	CIANSI      bool   // the CI log renders ANSI
	Plain       bool   // agent mode: no colour or decoration at all, ASCII glyphs (18.2)
	// QueryBackground asks the terminal for its background colour (OSC 11) with a short time limit, returning dark,
	// light or "". Nil skips the query.
	QueryBackground func() string
}

// Setup decides each stream's colour, depth and glyphs, and returns the UI that draws with them.
func Setup(io *iostreams.IOStreams, s Settings) *UI {
	u := New(io)
	switch strings.ToLower(s.Glyphs) {
	case "ascii":
		u.G = ASCIIGlyphs
	case "unicode":
		u.G = UnicodeGlyphs
	}
	if s.Plain {
		u.G = ASCIIGlyphs
		return u
	}
	choice := ColorChoice{Flag: s.ColorFlag, Config: s.ColorConfig, Getenv: io.Getenv, CIANSI: s.CIANSI}
	theme := strings.ToLower(s.Theme)
	bg := ""
	switch theme {
	case "dark", "light":
		bg = theme
	case "mono":
	default:
		if io.IsStdoutTTY() || io.IsStderrTTY() {
			if s.QueryBackground != nil {
				bg = s.QueryBackground()
			}
			if bg == "" {
				bg = BackgroundFromEnv(io.Getenv)
			}
		}
	}
	u.Background = bg
	profile := DetectProfile(io.Getenv, s.CIANSI && !io.IsStderrTTY())
	links := linksSupported(io.Getenv)
	styler := func(tty bool) Styler {
		on, _ := choice.Decide(tty)
		switch {
		case on:
			return ANSIStyler{Profile: profile, Background: bg, Accessible: s.Accessible, Mono: theme == "mono", Links: links && tty}
		case tty && io.Getenv("TERM") != "dumb":
			// No colour, but a terminal: bold and underline still mark hierarchy (12.4)
			return ANSIStyler{Profile: ANSI, Background: bg, Mono: true}
		default:
			return plain{}
		}
	}
	// Data on stdout is never coloured when stdout is not a terminal, whatever the switches (12.3)
	if io.IsStdoutTTY() {
		u.Out = styler(true)
	}
	u.Err = styler(io.IsStderrTTY())
	if on, _ := choice.Decide(io.IsStdoutTTY()); on && io.IsStdoutTTY() {
		io.ColorOut, io.ProfileOut = true, string(profile)
	}
	if on, _ := choice.Decide(io.IsStderrTTY()); on {
		io.ColorErr, io.ProfileErr = true, string(profile)
	}
	return u
}

// linksSupported: terminals known to show OSC 8 hyperlinks.
func linksSupported(getenv func(string) string) bool {
	switch getenv("TERM_PROGRAM") {
	case "iTerm.app", "WezTerm", "ghostty", "vscode", "Hyper":
		return true
	}
	return getenv("KITTY_WINDOW_ID") != "" || getenv("WT_SESSION") != "" || getenv("VTE_VERSION") != ""
}
