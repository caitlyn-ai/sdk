package emblem

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/assets"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// MinWidth is the narrowest terminal that shows the emblem.
const MinWidth = 60

// SystemProbe reaches the real terminal; tests replace it.
var SystemProbe = func(f *cmdutil.Factory) Probe {
	return Probe{Getenv: f.IO.Getenv, Query: ui.SystemQuerier(f.IO), WinSize: winSize}
}

// Why says why the emblem isn't shown, or "" when it may be, before asking the terminal anything (19.1).
func Why(f *cmdutil.Factory, u *ui.UI) string {
	get := f.IO.Getenv
	switch {
	case f.CI.In():
		return "CI"
	case f.Agent.On:
		return "agent mode"
	case !f.IO.IsStdoutTTY() || !f.IO.IsStderrTTY():
		return "stdout or stderr isn't a terminal"
	case get("TERM") == "dumb":
		return "TERM=dumb"
	case f.IO.Width() < MinWidth:
		return fmt.Sprintf("narrower than %d columns", MinWidth)
	case ui.InMultiplexer(get):
		return "inside tmux or screen"
	case get("CAITLYN_LOGO") == "0" || strings.EqualFold(get("CAITLYN_LOGO"), "false"):
		return "CAITLYN_LOGO=0"
	case u.Background == "":
		return "the background is unknown"
	}
	if cfg, err := f.Config(); err == nil && cfg != nil {
		if v := cfg.Get("logo"); v.Set && v.Value != "" && !cfg.Bool("logo") {
			return "logo = false"
		}
	}
	if format, err := output.Resolve(f); err == nil && format != output.Table && format != output.Text {
		return "a machine format"
	}
	return ""
}

// Image is the emblem's escape sequence and the text column beside it, or "" when it isn't shown.
func Image(f *cmdutil.Factory, u *ui.UI) (string, int) {
	if Why(f, u) != "" {
		return "", 0
	}
	s := Detect(SystemProbe(f))
	return imageFor(s, u.Background)
}

// imageFor draws the emblem for the support found: white on dark, black on light (never amber, never on a fill).
func imageFor(s Support, background string) (string, int) {
	pngData := assets.EmblemWhite
	if background == "light" {
		pngData = assets.EmblemBlack
	}
	switch s.Protocol {
	case Kitty:
		return KittySeq(pngData, Rows), s.Column()
	case ITerm2:
		return ITerm2Seq(pngData, Rows), s.Column()
	case Sixel:
		if s.CellW == 0 || s.CellH == 0 {
			return "", 0 // Sixel needs the pixel size
		}
		seq, err := SixelSeq(pngData, Rows*s.CellH)
		if err != nil {
			return "", 0
		}
		return seq, s.Column()
	}
	return "", 0
}

// Screen is an emblem screen's text. The headline group is the first two lines: Lead, the Headline and After on
// the first, Detail (muted) on the second. Rest flows below in the same column.
type Screen struct {
	// Lead is painted text before the headline, such as a ✓.
	Lead string
	// Headline is the screen's one Caitlyn moment: brand yellow on dark and bold ink on light beside the emblem,
	// strong without it (12.2).
	Headline string
	// After follows the headline in the terminal's own colour, such as an email address.
	After  string
	Detail string
	// Rest are painted lines, blank lines included.
	Rest []string
}

// Lines paints the screen's text, with the headline in its emblem colour or strong.
func (s Screen) Lines(u *ui.UI, withEmblem bool) []string {
	role := ui.Strong
	if withEmblem {
		role = ui.Headline
	}
	first := u.S(role, s.Headline)
	if s.Lead != "" {
		first = s.Lead + " " + first
	}
	if s.After != "" {
		first += " " + s.After
	}
	lines := []string{first}
	if s.Detail != "" || len(s.Rest) > 0 {
		detail := u.S(ui.Muted, s.Detail)
		if s.Lead != "" && !withEmblem && s.Detail != "" {
			// under the headline, past its lead (12.10's sign-in screen); beside the emblem the column aligns them
			detail = strings.Repeat(" ", ui.DisplayWidth(s.Lead)+1) + detail
		}
		lines = append(lines, detail)
	}
	return append(lines, s.Rest...)
}

// Draw writes a screen with the emblem when it may be shown, and as text alone otherwise (19.4).
func Draw(f *cmdutil.Factory, u *ui.UI, w io.Writer, s Screen) {
	img, col := Image(f, u)
	fmt.Fprint(w, render(u, s, img, col))
}

func render(u *ui.UI, s Screen, img string, col int) string {
	if img == "" {
		var b strings.Builder
		for _, l := range s.Lines(u, false) {
			b.WriteString(l + "\n")
		}
		return b.String()
	}
	return Compose(img, col, s.Lines(u, true))
}

// Identity is the welcome screen's detail line: the workspace and who is signed in. The sign-in package replaces it
// with the signed-in person's name from its cache; it must not call Caitlyn.
var Identity = func(f *cmdutil.Factory) string {
	cfg, err := f.Config()
	if err != nil || cfg == nil || cfg.String("workspace") == "" {
		return "Not signed in yet: caitlyn auth login"
	}
	return cfg.String("workspace") + " · profile " + cfg.Profile()
}

// WelcomeScreen is `caitlyn` with no arguments (19.5).
func WelcomeScreen(f *cmdutil.Factory, u *ui.UI) Screen {
	id := Identity(f)
	if !u.G.Unicode {
		id = strings.ReplaceAll(id, "·", u.G.Dot)
	}
	cmds := [][2]string{
		{"caitlyn agents list", "your agents"},
		{`caitlyn chat <agent> "` + u.G.Ellipsis + `"`, "ask an agent"},
		{"caitlyn kb sync <kb> <folder>", "keep a folder in step"},
		{"caitlyn ai setup", "set up your AI coding tools"},
	}
	rest := []string{"", u.S(ui.Strong, "Start here")}
	for _, c := range cmds {
		rest = append(rest, fmt.Sprintf("  %-31s  %s", c[0], u.S(ui.Muted, c[1])))
	}
	rest = append(rest, "", u.S(ui.Muted, "caitlyn --help "+u.G.Dot+" https://build.caitlyn.ai/cli/"))
	return Screen{Headline: "Caitlyn CLI " + versionOr(f.Version), Detail: id, Rest: rest}
}

func versionOr(v string) string {
	if v == "" {
		return "(development build)"
	}
	return v
}

// Welcome draws the welcome screen; without a terminal, or for an AI agent, it prints the help instead.
func Welcome(f *cmdutil.Factory, u *ui.UI, cmd *cobra.Command) error {
	if !f.IO.IsStdoutTTY() || f.Agent.On {
		return cmd.Help()
	}
	Draw(f, u, f.IO.Out, WelcomeScreen(f, u))
	return nil
}

// SignedIn draws sign-in success (12.10): `✓ Signed in as Aroha Ngata (aroha.ngata@example.govt.nz)` and the
// profile line, with the emblem. The sign-in helper calls it on stderr.
func SignedIn(f *cmdutil.Factory, u *ui.UI, w io.Writer, name, email, detail string) {
	after := ""
	if email != "" {
		after = "(" + email + ")"
	}
	Draw(f, u, w, Screen{Lead: u.S(ui.Success, u.G.Success), Headline: "Signed in as " + name, After: after, Detail: detail})
}

// Version draws `caitlyn version --logo`: the headline ("caitlyn 0.12.0"), the detail line (the workspace's
// release) and any further lines.
func Version(f *cmdutil.Factory, u *ui.UI, w io.Writer, headline, after, detail string, rest ...string) {
	Draw(f, u, w, Screen{Headline: headline, After: after, Detail: detail, Rest: rest})
}

// FirstRun draws the first-run screen: a greeting beside the emblem, then the notice (the telemetry notice) below
// it. The first-run hook calls it before its first command's output, on stderr.
func FirstRun(f *cmdutil.Factory, u *ui.UI, w io.Writer, greeting, detail string, notice []string) {
	rest := append([]string{""}, notice...)
	Draw(f, u, w, Screen{Headline: greeting, Detail: detail, Rest: rest})
}
