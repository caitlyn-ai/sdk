package ui

import (
	"strings"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

func env(kv ...string) func(string) string {
	m := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return func(k string) string { return m[k] }
}

// The order of switches in 12.3, first match wins, for every combination of the switches.
func TestColorChoiceOrder(t *testing.T) {
	flags := []string{"", "always", "never", "auto"}
	envs := []string{"", "always", "never"}
	configs := []string{"", "always", "never"}
	noColor := []string{"", "1"}
	force := []string{"", "1", "0"}
	clicolorForce := []string{"", "1"}
	clicolor := []string{"", "0"}
	terms := []string{"xterm", "dumb"}
	for _, flag := range flags {
		for _, ce := range envs {
			for _, cfg := range configs {
				for _, nc := range noColor {
					for _, fc := range force {
						for _, cf := range clicolorForce {
							for _, cl := range clicolor {
								for _, term := range terms {
									for _, tty := range []bool{true, false} {
										c := ColorChoice{Flag: flag, Config: cfg, Getenv: env("CAITLYN_COLOR", ce, "NO_COLOR", nc, "FORCE_COLOR", fc, "CLICOLOR_FORCE", cf, "CLICOLOR", cl, "TERM", term)}
										got, rule := c.Decide(tty)
										want, wantRule := expectColour(flag, ce, cfg, nc, fc, cf, cl, term, tty)
										if got != want || rule != wantRule {
											t.Fatalf("flag=%q CAITLYN_COLOR=%q config=%q NO_COLOR=%q FORCE_COLOR=%q CLICOLOR_FORCE=%q CLICOLOR=%q TERM=%q tty=%v: got %v (%s), want %v (%s)",
												flag, ce, cfg, nc, fc, cf, cl, term, tty, got, rule, want, wantRule)
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}
}

func expectColour(flag, ce, cfg, nc, fc, cf, cl, term string, tty bool) (bool, string) {
	switch {
	case flag == "always":
		return true, "--color"
	case flag == "never":
		return false, "--color"
	case ce == "always":
		return true, "CAITLYN_COLOR"
	case ce == "never":
		return false, "CAITLYN_COLOR"
	case cfg == "always":
		return true, "color in configuration"
	case cfg == "never":
		return false, "color in configuration"
	case nc != "":
		return false, "NO_COLOR"
	case fc != "" && fc != "0":
		return true, "FORCE_COLOR"
	case cf != "" && cf != "0":
		return true, "CLICOLOR_FORCE"
	case cl == "0":
		return false, "CLICOLOR=0"
	case term == "dumb":
		return false, "TERM=dumb"
	case tty:
		return true, "a terminal"
	}
	return false, "not a terminal"
}

func TestColorChoiceCI(t *testing.T) {
	c := ColorChoice{Getenv: env(), CIANSI: true}
	if on, rule := c.Decide(false); !on || rule != "a CI log that shows colour" {
		t.Fatalf("got %v %q", on, rule)
	}
}

// The headline's escape codes (19.6).
func TestHeadlineCodes(t *testing.T) {
	cases := []struct {
		name string
		s    ANSIStyler
		want string
	}{
		{"truecolour dark", ANSIStyler{Profile: TrueColor, Background: "dark"}, "\x1b[38;2;255;187;38mCaitlyn\x1b[m"},
		{"256 dark", ANSIStyler{Profile: ANSI256, Background: "dark"}, "\x1b[38;5;214mCaitlyn\x1b[m"},
		{"16 dark", ANSIStyler{Profile: ANSI, Background: "dark"}, "\x1b[93mCaitlyn\x1b[m"},
		{"accessible dark", ANSIStyler{Profile: TrueColor, Background: "dark", Accessible: true}, "\x1b[93mCaitlyn\x1b[m"},
		{"truecolour light", ANSIStyler{Profile: TrueColor, Background: "light"}, "\x1b[1;38;2;10;12;11mCaitlyn\x1b[m"},
		{"256 light", ANSIStyler{Profile: ANSI256, Background: "light"}, "\x1b[1;38;5;232mCaitlyn\x1b[m"},
		{"16 light", ANSIStyler{Profile: ANSI, Background: "light"}, "\x1b[1mCaitlyn\x1b[m"},
		{"unknown background", ANSIStyler{Profile: TrueColor}, "\x1b[1mCaitlyn\x1b[m"},
		{"NO_COLOR on a terminal (mono)", ANSIStyler{Profile: ANSI, Background: "dark", Mono: true}, "\x1b[1mCaitlyn\x1b[m"},
		{"no colour at all", ANSIStyler{}, "Caitlyn"},
	}
	for _, c := range cases {
		if got := c.s.Paint(Headline, "Caitlyn"); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	if got := (plain{}).Paint(Headline, "Caitlyn"); got != "Caitlyn" {
		t.Errorf("plain: %q", got)
	}
}

func TestRoleCodes(t *testing.T) {
	dark := ANSIStyler{Profile: TrueColor, Background: "dark"}
	light := ANSIStyler{Profile: TrueColor, Background: "light"}
	ansi := ANSIStyler{Profile: ANSI, Background: "dark"}
	mono := ANSIStyler{Profile: ANSI, Background: "dark", Mono: true}
	cases := []struct {
		s    ANSIStyler
		r    Role
		want string
	}{
		{dark, Strong, "\x1b[1mx\x1b[m"},
		{dark, Muted, "\x1b[38;2;168;176;173mx\x1b[m"},
		{light, Muted, "\x1b[38;2;102;116;112mx\x1b[m"},
		{ANSIStyler{Profile: ANSI256, Background: "dark"}, Muted, "\x1b[38;5;248mx\x1b[m"},
		{ansi, Muted, "\x1b[90mx\x1b[m"},
		{dark, Rule, "\x1b[38;2;46;51;49mx\x1b[m"},
		{dark, Accent, "\x1b[38;2;255;187;38mx\x1b[m"},
		{light, Accent, "\x1b[1mx\x1b[m"}, // amber is never text on light
		{dark, Marker, "\x1b[38;2;255;146;7mx\x1b[m"},
		{ansi, Success, "\x1b[32mx\x1b[m"},
		{ansi, Error, "\x1b[31mx\x1b[m"},
		{ansi, Warning, "\x1b[33mx\x1b[m"},
		{dark, Added, "\x1b[32mx\x1b[m"},
		{dark, Link, "\x1b[4mx\x1b[m"},
		{dark, Quote, "\x1b[3mx\x1b[m"},
		{mono, Success, "x"},
		{mono, Strong, "\x1b[1mx\x1b[m"},
		{mono, Muted, "x"},
		{dark, Default, "x"},
	}
	for _, c := range cases {
		if got := c.s.Paint(c.r, "x"); got != c.want {
			t.Errorf("%+v role %d: %q, want %q", c.s, c.r, got, c.want)
		}
	}
	// lines are styled one by one
	if got := dark.Paint(Strong, "a\nb"); got != "\x1b[1ma\x1b[m\n\x1b[1mb\x1b[m" {
		t.Errorf("multi-line: %q", got)
	}
	// tabs survive
	if got := dark.Paint(Strong, "a\tb"); got != "\x1b[1ma\tb\x1b[m" {
		t.Errorf("tab: %q", got)
	}
}

func TestHyperlink(t *testing.T) {
	a := ANSIStyler{Profile: TrueColor, Background: "dark", Links: true}
	if got := a.Hyperlink("https://x.test", "x"); got != "\x1b]8;;https://x.test\x1b\\\x1b[4mx\x1b[m\x1b]8;;\x1b\\" {
		t.Errorf("OSC 8: %q", got)
	}
	a.Links = false
	if got := a.Hyperlink("https://x.test", "x"); got != "x https://x.test" {
		t.Errorf("no links: %q", got)
	}
}

func TestDetectProfile(t *testing.T) {
	cases := []struct {
		env  func(string) string
		ci   bool
		want Profile
	}{
		{env("TERM", "xterm-256color", "COLORTERM", "truecolor"), false, TrueColor},
		{env("TERM", "xterm-256color", "COLORTERM", "24bit"), false, TrueColor},
		{env("TERM", "xterm-256color"), false, ANSI256},
		{env("TERM", "xterm"), false, ANSI},
		{env("TERM", "xterm", "TERM_PROGRAM", "iTerm.app"), false, TrueColor},
		{env("TERM", "xterm-kitty"), false, TrueColor},
		{env("TERM", "xterm-256color", "COLORTERM", "truecolor", "NO_COLOR", "1"), false, TrueColor}, // depth only
		{env("TERM", "xterm-256color", "COLORTERM", "truecolor"), true, ANSI},
		{env("TERM", "dumb"), false, ANSI},
	}
	for i, c := range cases {
		if got := DetectProfile(c.env, c.ci); got != c.want {
			t.Errorf("case %d: %q, want %q", i, got, c.want)
		}
	}
}

func TestBackgroundFromEnv(t *testing.T) {
	for v, want := range map[string]string{"15;0": "dark", "0;15": "light", "0;7": "light", "15;default;0": "dark", "": "", "x": ""} {
		if got := BackgroundFromEnv(env("COLORFGBG", v)); got != want {
			t.Errorf("COLORFGBG=%q: %q, want %q", v, got, want)
		}
	}
}

func TestBackgroundFromReply(t *testing.T) {
	cases := map[string]string{
		"\x1b]11;rgb:0a0a/0c0c/0b0b\x1b\\\x1b[?62;4c": "dark",
		"\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?62c":     "light",
		"\x1b]11;rgb:ff/ff/ff\x07":                    "light",
		"\x1b]11;rgba:2e2e/3333/3131/ffff\x07":        "dark",
		"\x1b[?62;22c":                                "",
		"":                                            "",
	}
	for reply, want := range cases {
		if got := BackgroundFromReply([]byte(reply)); got != want {
			t.Errorf("%q: %q, want %q", reply, got, want)
		}
	}
}

type fakeQuerier struct {
	reply string
	asked string
}

func (f *fakeQuerier) Query(q string, done func([]byte) bool, _ time.Duration) []byte {
	f.asked = q
	return []byte(f.reply)
}

func TestQueryBackground(t *testing.T) {
	q := &fakeQuerier{reply: "\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[?1;2c"}
	if got := QueryBackground(q); got != "dark" {
		t.Fatalf("got %q", got)
	}
	if q.asked != "\x1b]11;?\x07\x1b[c" {
		t.Errorf("asked %q: want OSC 11 then DA1", q.asked)
	}
	if got := QueryBackground(nil); got != "" {
		t.Errorf("no querier: %q", got)
	}
	if !HasDA1([]byte("x\x1b[?64;1;4c")) || HasDA1([]byte("\x1b]11;rgb:0/0/0\x07")) {
		t.Error("HasDA1")
	}
}

func TestSetupBackgroundOrder(t *testing.T) {
	io, _, _ := iostreams.Test("")
	io.SetTTY(true, true, true)
	io.Environ = []string{"TERM=xterm-256color", "COLORFGBG=0;15"}
	asked := false
	u := Setup(io, Settings{QueryBackground: func() string { asked = true; return "dark" }})
	if !asked || u.Background != "dark" {
		t.Fatalf("the OSC 11 answer comes first: %q", u.Background)
	}
	u = Setup(io, Settings{QueryBackground: func() string { return "" }})
	if u.Background != "light" {
		t.Fatalf("COLORFGBG next: %q", u.Background)
	}
	io.Environ = []string{"TERM=xterm-256color"}
	if u = Setup(io, Settings{QueryBackground: func() string { return "" }}); u.Background != "" {
		t.Fatalf("unknown: %q", u.Background)
	}
	asked = false
	if u = Setup(io, Settings{Theme: "light", QueryBackground: func() string { asked = true; return "dark" }}); asked || u.Background != "light" {
		t.Fatalf("theme = light skips the query: %q %v", u.Background, asked)
	}
	io.SetTTY(false, false, false)
	asked = false
	if Setup(io, Settings{QueryBackground: func() string { asked = true; return "dark" }}); asked {
		t.Fatal("no query without a terminal")
	}
}

func TestSetupStreams(t *testing.T) {
	io, _, _ := iostreams.Test("")
	io.SetTTY(true, false, true)
	io.Environ = []string{"TERM=xterm-256color", "FORCE_COLOR=1"}
	u := Setup(io, Settings{Theme: "dark"})
	if _, ok := u.Out.(plain); !ok {
		t.Error("data on stdout is never coloured when stdout isn't a terminal, whatever the switches")
	}
	if a, ok := u.Err.(ANSIStyler); !ok || a.Profile != ANSI256 {
		t.Errorf("stderr: %#v", u.Err)
	}
	u = Setup(io, Settings{Theme: "mono"})
	if a := u.Err.(ANSIStyler); !a.Mono {
		t.Error("theme = mono")
	}
	u = Setup(io, Settings{Theme: "dark", Accessible: true})
	if got := u.Err.Paint(Muted, "x"); got != "\x1b[90mx\x1b[m" {
		t.Errorf("accessible_colors: %q", got)
	}
	u = Setup(io, Settings{Plain: true})
	if _, ok := u.Err.(plain); !ok || u.G.Unicode {
		t.Error("agent mode: no colour, ASCII glyphs")
	}
}

func TestGlyphSelection(t *testing.T) {
	io, _, _ := iostreams.Test("")
	for _, c := range []struct {
		env     []string
		glyphs  string
		unicode bool
	}{
		{[]string{"LANG=en_NZ.UTF-8"}, "", true},
		{[]string{"LC_ALL=C", "LANG=en_NZ.UTF-8"}, "", false},
		{[]string{"LANG=en_NZ.UTF-8", "TERM=dumb"}, "", false},
		{[]string{"LANG=en_NZ.UTF-8"}, "ascii", false},
		{[]string{"LANG=C"}, "unicode", true},
	} {
		io.Environ = c.env
		if got := Setup(io, Settings{Glyphs: c.glyphs}).G.Unicode; got != c.unicode {
			t.Errorf("%v glyphs=%q: unicode %v", c.env, c.glyphs, got)
		}
	}
	if strings.Join(ASCIIGlyphs.Spinner, "") != `-\|/` {
		t.Error("ASCII spinner")
	}
}
