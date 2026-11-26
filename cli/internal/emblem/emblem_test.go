package emblem

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/cli/assets"
	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
	"github.com/caitlyn-ai/sdk/cli/internal/ui/uitest"
)

func env(kv ...string) func(string) string {
	m := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return func(k string) string { return m[k] }
}

// scripted is a terminal that answers queries from a script, or not at all.
type scripted struct {
	reply string
	asked []string
}

func (s *scripted) Query(q string, done func([]byte) bool, limit time.Duration) []byte {
	s.asked = append(s.asked, q)
	if limit != ui.QueryLimit {
		panic("every query shares the 100 ms limit")
	}
	return []byte(s.reply)
}

func TestFromEnv(t *testing.T) {
	cases := []struct {
		env  func(string) string
		want Protocol
	}{
		{env("KITTY_WINDOW_ID", "1"), Kitty},
		{env("TERM", "xterm-kitty"), Kitty},
		{env("TERM_PROGRAM", "ghostty"), Kitty},
		{env("TERM_PROGRAM", "iTerm.app"), ITerm2},
		{env("LC_TERMINAL", "iTerm2"), ITerm2},
		{env("TERM_PROGRAM", "WezTerm"), Kitty},
		{env("TERM_PROGRAM", "Apple_Terminal"), None},
		{env(), None},
	}
	for i, c := range cases {
		if got := FromEnv(c.env); got != c.want {
			t.Errorf("case %d: %v, want %v", i, got, c.want)
		}
	}
}

func TestDetectFromReplies(t *testing.T) {
	cases := []struct {
		name  string
		reply string
		want  Protocol
	}{
		{"graphics reply", "\x1b_Gi=31;OK\x1b\\\x1b[?62;22c", Kitty},
		{"DA1 with 4", "\x1b[?62;4;22c", Sixel},
		{"DA1 with 4 first in class position only", "\x1b[?4c", None},
		{"DA1 alone", "\x1b[?62;22c", None},
		{"no reply within 100 ms", "", None},
	}
	for _, c := range cases {
		q := &scripted{reply: c.reply}
		s := Detect(Probe{Getenv: env("TERM", "xterm-256color"), Query: q})
		if s.Protocol != c.want {
			t.Errorf("%s: %v, want %v", c.name, s.Protocol, c.want)
		}
		if len(q.asked) != 1 || !strings.HasPrefix(q.asked[0], KittyQuery) || !strings.HasSuffix(q.asked[0], "\x1b[c") {
			t.Errorf("%s: one query, Kitty's a=q then DA1: %q", c.name, q.asked)
		}
	}
	if KittyQuery != "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\" {
		t.Error("the Kitty query")
	}
}

func TestNoQueryWhereUnsafe(t *testing.T) {
	for name, e := range map[string]func(string) string{
		"TERM=dumb": env("TERM", "dumb"),
		"tmux":      env("TERM", "screen-256color", "TMUX", "/tmp/tmux"),
		"screen":    env("TERM", "xterm", "STY", "1.pts"),
	} {
		q := &scripted{reply: "\x1b_Gi=31;OK\x1b\\"}
		if s := Detect(Probe{Getenv: e, Query: q}); len(q.asked) != 0 || s.Protocol != None {
			t.Errorf("%s: asked %q", name, q.asked)
		}
	}
	// stdin isn't the terminal: no Querier at all
	if s := Detect(Probe{Getenv: env("TERM", "xterm")}); s.Protocol != None {
		t.Error("no querier")
	}
}

func TestCellSize(t *testing.T) {
	ws := func(c, r, x, y int) func() (int, int, int, int, bool) {
		return func() (int, int, int, int, bool) { return c, r, x, y, true }
	}
	// the ioctl's pixel fields, with no query when the protocol is known from the environment
	q := &scripted{}
	s := Detect(Probe{Getenv: env("TERM", "xterm-kitty"), Query: q, WinSize: ws(100, 40, 900, 760)})
	if s.CellW != 9 || s.CellH != 19 || len(q.asked) != 0 {
		t.Fatalf("ioctl: %+v, asked %q", s, q.asked)
	}
	// CSI 16 t
	q = &scripted{reply: "\x1b[6;20;10t\x1b[4;800;1000t\x1b[?62c"}
	s = Detect(Probe{Getenv: env("TERM", "xterm-kitty"), Query: q, WinSize: ws(100, 40, 0, 0)})
	if s.CellW != 10 || s.CellH != 20 || q.asked[0] != CellQueries+"\x1b[c" {
		t.Fatalf("CSI 16 t: %+v %q", s, q.asked)
	}
	// CSI 14 t divided by the columns and rows
	q = &scripted{reply: "\x1b[4;680;800t\x1b[?62c"}
	s = Detect(Probe{Getenv: env("TERM", "xterm-kitty"), Query: q, WinSize: ws(100, 40, 0, 0)})
	if s.CellW != 8 || s.CellH != 17 {
		t.Fatalf("CSI 14 t: %+v", s)
	}
	// none answered
	q = &scripted{reply: "\x1b[?62c"}
	s = Detect(Probe{Getenv: env("TERM", "xterm-kitty"), Query: q, WinSize: ws(100, 40, 0, 0)})
	if s.CellW != 0 || s.CellH != 0 {
		t.Fatalf("none: %+v", s)
	}
	// the protocol and the cell size in one query
	q = &scripted{reply: "\x1b[6;19;9t\x1b[?62;4c"}
	s = Detect(Probe{Getenv: env("TERM", "xterm"), Query: q})
	if s.Protocol != Sixel || s.CellW != 9 || len(q.asked) != 1 || q.asked[0] != KittyQuery+CellQueries+"\x1b[c" {
		t.Fatalf("combined: %+v %q", s, q.asked)
	}
}

// The text column: ceil(width ÷ cell width) + 2, at the three preview cells and a 1:2.4 cell (19.6).
func TestTextColumn(t *testing.T) {
	cases := []struct {
		w, h, want int
	}{{10, 20, 14}, {9, 19, 15}, {8, 17, 15}, {10, 24, 17}}
	for _, c := range cases {
		if got := (Support{Protocol: Kitty, CellW: c.w, CellH: c.h}).Column(); got != c.want {
			t.Errorf("%dx%d: %d, want %d", c.w, c.h, got, c.want)
		}
	}
	if got := (Support{Protocol: Kitty}).Column(); got != 17 {
		t.Errorf("unknown cell: %d", got)
	}
}

func TestKittySequence(t *testing.T) {
	seq := KittySeq(assets.EmblemWhite, Rows)
	chunks := regexp.MustCompile(`\x1b_G([^;]*);([^\x1b]*)\x1b\\`).FindAllStringSubmatch(seq, -1)
	if len(chunks) < 2 {
		t.Fatalf("%d chunks", len(chunks))
	}
	var b64 strings.Builder
	for i, c := range chunks {
		if len(c[2]) > ChunkSize {
			t.Errorf("chunk %d carries %d bytes", i, len(c[2]))
		}
		b64.WriteString(c[2])
		if strings.Contains(c[1], "c=") {
			t.Errorf("chunk %d sends columns: %q", i, c[1])
		}
		last := i == len(chunks)-1
		if strings.HasSuffix(c[1], "m=0") != last {
			t.Errorf("chunk %d: %q", i, c[1])
		}
	}
	if chunks[0][1] != "a=T,f=100,t=d,r=6,C=1,q=2,m=1" {
		t.Errorf("first chunk's keys: %q (only r= for the size)", chunks[0][1])
	}
	if got, _ := base64.StdEncoding.DecodeString(b64.String()); string(got) != string(assets.EmblemWhite) {
		t.Error("the chunks don't rebuild the PNG")
	}
	uitest.Compare(t, "kitty", []byte(seq))
}

func TestITerm2Sequence(t *testing.T) {
	seq := ITerm2Seq(assets.EmblemBlack, Rows)
	want := "\x1b]1337;File=inline=1;height=6;preserveAspectRatio=1:" + base64.StdEncoding.EncodeToString(assets.EmblemBlack) + "\a"
	if seq != want {
		t.Fatal("iTerm2 sequence")
	}
	if strings.Contains(seq, "width=") {
		t.Error("no width")
	}
	uitest.Compare(t, "iterm2", []byte(seq))
}

func TestSixelSequence(t *testing.T) {
	seq, err := SixelSeq(assets.EmblemWhite, Rows*19)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(seq, "\x1bP0;1;0q\"1;1;114;114#0;2;100;100;100") || !strings.HasSuffix(seq, "-\x1b\\") {
		t.Fatalf("framing: %q…", seq[:40])
	}
	if bands := strings.Count(seq, "-"); bands != 19 {
		t.Errorf("%d bands for 114 rows, want 19", bands)
	}
	black, _ := SixelSeq(assets.EmblemBlack, 60)
	if !strings.Contains(black, "#0;2;5;5;5") {
		t.Error("the black emblem's colour")
	}
	uitest.Compare(t, "sixel-9x19", []byte(seq))
}

// The alignment rule: the headline pair on the emblem's rows 2 and 3, the rest flowing below in the same column.
func TestCompose(t *testing.T) {
	got := Compose("<IMG>", 15, []string{"Head", "detail", "", "Start here", "  one", "  two", "  three", "", "help"})
	rows := strings.Split(strings.TrimSuffix(got[strings.Index(got, "\x1b8")+2:], "\n"), "\n")
	if !strings.HasPrefix(got, strings.Repeat("\n", 10)+"\x1b[10A\r\x1b7<IMG>\x1b8") {
		t.Fatalf("reserve, then save, draw and restore: %q", got[:30])
	}
	want := []string{"", "", "\x1b[15CHead", "\x1b[15Cdetail", "", "\x1b[15CStart here", "\x1b[15C  one", "\x1b[15C  two", "\x1b[15C  three", "", "\x1b[15Chelp"}
	if fmt.Sprint(rows) != fmt.Sprint(want) {
		t.Fatalf("rows %q\nwant %q", rows, want)
	}
	short := Compose("<IMG>", 14, []string{"Head", "detail"})
	if strings.Count(short, "\n") != 5+6 {
		t.Errorf("a two-line screen is the emblem's 6 rows high: %q", short)
	}
}

func factory(t *testing.T, p uitest.Profile, width int, extra ...string) *uitest.Term {
	return uitest.New(t, p, width, extra...)
}

func withProbe(t *testing.T, s Support) {
	old := SystemProbe
	t.Cleanup(func() { SystemProbe = old })
	SystemProbe = func(f *cmdutil.Factory) Probe {
		return Probe{Getenv: func(k string) string {
			if k == "TERM_PROGRAM" && s.Protocol == Kitty {
				return "ghostty"
			}
			if k == "TERM_PROGRAM" && s.Protocol == ITerm2 {
				return "iTerm.app"
			}
			return ""
		}, WinSize: func() (int, int, int, int, bool) { return 100, 40, 100 * s.CellW, 40 * s.CellH, true },
			Query: &scripted{reply: map[Protocol]string{Sixel: "\x1b[?62;4c"}[s.Protocol]}}
	}
}

func TestWhy(t *testing.T) {
	p := uitest.Profiles[0]
	cases := map[string]func(tm *uitest.Term){
		"CI":         func(tm *uitest.Term) { tm.F.CI = ci.Provider{Name: "github"} },
		"agent mode": func(tm *uitest.Term) { tm.F.Agent = agent.Mode{On: true} },
		"stdout or stderr isn't a terminal": func(tm *uitest.Term) {
			tm.IO.SetTTY(true, false, true)
		},
		"TERM=dumb":                func(tm *uitest.Term) { tm.IO.Setenv("TERM", "dumb") },
		"narrower than 60 columns": func(tm *uitest.Term) { tm.IO.SetWidth(59) },
		"inside tmux or screen":    func(tm *uitest.Term) { tm.IO.Setenv("TMUX", "/tmp/x") },
		"CAITLYN_LOGO=0":           func(tm *uitest.Term) { tm.IO.Setenv("CAITLYN_LOGO", "0") },
		"the background is unknown": func(tm *uitest.Term) {
			tm.U = ui.Setup(tm.IO, ui.Settings{})
		},
		"a machine format": func(tm *uitest.Term) { tm.F.Globals.Output = "json" },
	}
	for want, setup := range cases {
		tm := factory(t, p, 80)
		setup(tm)
		if got := Why(tm.F, tm.U); got != want {
			t.Errorf("%s: got %q", want, got)
		}
		if img, _ := Image(tm.F, tm.U); img != "" {
			t.Errorf("%s: an emblem was drawn", want)
		}
	}
	tm := factory(t, p, 80)
	if got := Why(tm.F, tm.U); got != "" {
		t.Errorf("allowed: %q", got)
	}
}

func TestNoEmblemWhenUnknown(t *testing.T) {
	if img, _ := imageFor(Support{Protocol: None, CellW: 9, CellH: 19}, "dark"); img != "" {
		t.Error("no protocol: no emblem")
	}
	if img, _ := imageFor(Support{Protocol: Sixel}, "dark"); img != "" {
		t.Error("Sixel with no cell size: no emblem")
	}
	if img, col := imageFor(Support{Protocol: Kitty}, "light"); img != KittySeq(assets.EmblemBlack, Rows) || col != 17 {
		t.Error("Kitty with no cell size still draws, black on light")
	}
	if img, col := imageFor(Support{Protocol: Sixel, CellW: 9, CellH: 19}, "dark"); !strings.HasPrefix(img, "\x1bP") || col != 15 {
		t.Error("Sixel at a measured size")
	}
}

// The headline's colour beside the emblem, at each depth (19.6), and strong without it.
func TestHeadlineColours(t *testing.T) {
	want := map[string]string{
		"truecolor-dark":  "\x1b[38;2;255;187;38mCaitlyn CLI 0.12.0\x1b[m",
		"truecolor-light": "\x1b[1;38;2;10;12;11mCaitlyn CLI 0.12.0\x1b[m",
		"ansi256":         "\x1b[38;5;214mCaitlyn CLI 0.12.0\x1b[m",
		"ansi":            "\x1b[93mCaitlyn CLI 0.12.0\x1b[m",
		"nocolor-ascii":   "\x1b[1mCaitlyn CLI 0.12.0\x1b[m",
	}
	for _, p := range uitest.Profiles {
		tm := factory(t, p, 80)
		s := Screen{Headline: "Caitlyn CLI 0.12.0", Detail: "d"}
		if got := s.Lines(tm.U, true)[0]; got != want[p.Name] {
			t.Errorf("%s: %q, want %q", p.Name, got, want[p.Name])
		}
		if got := s.Lines(tm.U, false)[0]; got != "\x1b[1mCaitlyn CLI 0.12.0\x1b[m" {
			t.Errorf("%s without the emblem: %q", p.Name, got)
		}
	}
	// unknown background: plain bold
	tm := factory(t, uitest.Profiles[0], 80)
	tm.U = ui.Setup(tm.IO, ui.Settings{})
	if got := (Screen{Headline: "x"}).Lines(tm.U, true)[0]; got != "\x1b[1mx\x1b[m" {
		t.Errorf("unknown background: %q", got)
	}
}

// The three screens, byte for byte, with Kitty at the 9×19 cell on dark and light, iTerm2 and Sixel on dark.
func TestScreens(t *testing.T) {
	supports := map[string]Support{
		"kitty-9x19":  {Protocol: Kitty, CellW: 9, CellH: 19},
		"iterm2-8x17": {Protocol: ITerm2, CellW: 8, CellH: 17},
		"sixel-10x20": {Protocol: Sixel, CellW: 10, CellH: 20},
	}
	for name, s := range supports {
		for _, p := range uitest.Profiles[:2] {
			if name != "kitty-9x19" && p.Name != "truecolor-dark" {
				continue
			}
			withProbe(t, s)
			tm := factory(t, p, 100)
			tm.F.Version = "0.12.0"
			Identity = func(*cmdutil.Factory) string { return "your-company.caitlyn.ai · signed in as Aroha Ngata" }
			Draw(tm.F, tm.U, tm.Out, WelcomeScreen(tm.F, tm.U))
			SignedIn(tm.F, tm.U, tm.Out, "Aroha Ngata", "aroha.ngata@example.govt.nz", "profile default · tokens in the macOS Keychain · scopes api:admin")
			Version(tm.F, tm.U, tm.Out, "caitlyn 0.12.0", tm.U.S(ui.Muted, "(Go SDK 0.12.0, model 5.144.0, darwin/arm64)"), "Workspace your-company.caitlyn.ai runs Caitlyn 5.144.0.")
			FirstRun(tm.F, tm.U, tm.Err, "Welcome to the Caitlyn CLI", "0.12.0", []string{"Usage data for Caitlyn is off. Turn it on: caitlyn telemetry on"})
			tm.Golden(t, "screens/"+name+"-"+p.Name)
			if !strings.Contains(tm.Out.String(), "\x1b[15C") && name == "kitty-9x19" {
				t.Errorf("the welcome text at column 15 for a 9×19 cell")
			}
		}
	}
}

func TestWelcomeWithoutATerminal(t *testing.T) {
	tm := factory(t, uitest.Profiles[0], 80)
	tm.IO.SetTTY(false, false, false)
	if Why(tm.F, tm.U) == "" {
		t.Fatal("pipes: no emblem")
	}
	withProbe(t, Support{Protocol: None})
	tm = factory(t, uitest.Profiles[4], 80)
	Draw(tm.F, tm.U, tm.Out, Screen{Headline: "Caitlyn CLI 0.12.0", Detail: "your-company.caitlyn.ai"})
	if got := tm.Out.String(); got != "\x1b[1mCaitlyn CLI 0.12.0\x1b[m\nyour-company.caitlyn.ai\n" {
		t.Errorf("text alone (19.4): %q", got)
	}
}
