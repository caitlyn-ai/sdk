package ui

import (
	"fmt"
	"regexp"
	"strings"

	"charm.land/glamour/v2"
	gansi "charm.land/glamour/v2/ansi"
)

// MarkdownStyle is the Caitlyn style for glamour (12.6): headings bold with no #, body in the terminal's own
// foreground, code blocks indented behind a rule-coloured bar, links underlined, block quotes in italic behind a
// muted bar, no document margin. Colours are given at the styler's depth, so nothing needs downsampling.
func (u *UI) MarkdownStyle() gansi.StyleConfig {
	s := u.Out
	t, f := true, false
	zero, one := uint(0), uint(1)
	str := func(v string) *string { return &v }
	bold := gansi.StylePrimitive{Bold: &t}
	heading := gansi.StyleBlock{StylePrimitive: bold}
	codeBar := s.Paint(Rule, u.G.Pipe) + " "
	quoteBar := s.Paint(Muted, u.G.Pipe) + " "
	rule := s.Paint(Rule, strings.Repeat(u.G.Rule, 24))
	center, column, row := "┼", "│", "─"
	if !u.G.Unicode {
		center, column, row = "+", "|", "-"
	}
	cfg := gansi.StyleConfig{
		Document:  gansi.StyleBlock{Margin: &zero},
		Paragraph: gansi.StyleBlock{},
		Heading:   gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Bold: &t, BlockSuffix: "\n"}},
		H1:        heading, H2: heading, H3: heading, H4: heading, H5: heading, H6: heading,
		Strong:         bold,
		Emph:           gansi.StylePrimitive{Italic: &t},
		Strikethrough:  gansi.StylePrimitive{CrossedOut: &t},
		HorizontalRule: gansi.StylePrimitive{Format: "\n" + rule + "\n"},
		Item:           gansi.StylePrimitive{BlockPrefix: u.G.Bullet + " "},
		Enumeration:    gansi.StylePrimitive{BlockPrefix: ". "},
		Task:           gansi.StyleTask{Ticked: "[" + u.G.Success + "] ", Unticked: "[ ] "},
		List:           gansi.StyleList{LevelIndent: 2},
		Link:           gansi.StylePrimitive{Underline: &f},
		LinkText:       gansi.StylePrimitive{Underline: &t},
		Code:           gansi.StyleBlock{},
		CodeBlock:      gansi.StyleCodeBlock{StyleBlock: gansi.StyleBlock{Indent: &one, IndentToken: &codeBar, Margin: &zero}},
		BlockQuote:     gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Italic: &t}, Indent: &one, IndentToken: &quoteBar},
		Table:          gansi.StyleTable{CenterSeparator: str(center), ColumnSeparator: str(column), RowSeparator: str(row)},
		ImageText:      gansi.StylePrimitive{Format: "{{.text}}"},
	}
	if !Colourful(s) && !isANSI(s) {
		// plain: no escape sequences at all
		cfg.Strong, cfg.Emph, cfg.LinkText, cfg.Strikethrough = gansi.StylePrimitive{}, gansi.StylePrimitive{}, gansi.StylePrimitive{}, gansi.StylePrimitive{}
		cfg.Heading = gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{BlockSuffix: "\n"}}
		cfg.H1, cfg.H2, cfg.H3, cfg.H4, cfg.H5, cfg.H6 = gansi.StyleBlock{}, gansi.StyleBlock{}, gansi.StyleBlock{}, gansi.StyleBlock{}, gansi.StyleBlock{}, gansi.StyleBlock{}
		cfg.BlockQuote.Italic = nil
	}
	return cfg
}

func isANSI(s Styler) bool { _, ok := s.(ANSIStyler); return ok }

var (
	citation     = regexp.MustCompile(`\[(\d{1,3})\]`)
	trailing     = regexp.MustCompile(`[ \t]+((?:\x1b\[[0-9;:]*m)*)$`)
	osc8         = regexp.MustCompile(`\x1b\]8;[^\x1b\x07]*(?:\x1b\\|\x07)`)
	blankEscapes = regexp.MustCompile(`^(?:\x1b\[[0-9;:]*m)*$`)
)

// Markdown renders Markdown for a terminal at the prose width (12.4), or returns it unchanged when stdout isn't a
// terminal: raw Markdown is the best form for another tool or an AI agent (12.6).
func (u *UI) Markdown(md string) string {
	if !u.IO.IsStdoutTTY() {
		return md
	}
	return u.renderMarkdown(md, u.IO.ProseWidth())
}

func (u *UI) renderMarkdown(md string, width int) string {
	r, err := glamour.NewTermRenderer(glamour.WithStyles(u.MarkdownStyle()), glamour.WithWordWrap(width))
	if err != nil {
		return md
	}
	out, err := r.Render(md)
	if err != nil {
		return md
	}
	return u.tidyMarkdown(out)
}

// tidyMarkdown trims glamour's padding (trailing spaces, blank first and last lines), paints citation numbers in the
// accent (12.8), and drops OSC 8 links where the terminal doesn't show them.
func (u *UI) tidyMarkdown(out string) string {
	if a, ok := u.Out.(ANSIStyler); !ok || !a.Links {
		out = osc8.ReplaceAllString(out, "")
	}
	lines := strings.Split(out, "\n")
	for i, l := range lines {
		lines[i] = trailing.ReplaceAllString(l, "$1")
		if blankEscapes.MatchString(lines[i]) {
			lines[i] = ""
		}
	}
	for len(lines) > 0 && lines[0] == "" {
		lines = lines[1:]
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	out = strings.Join(lines, "\n")
	return citation.ReplaceAllStringFunc(out, func(m string) string { return u.S(Marker, m) })
}

// Source is one citation under an agent's answer (12.8).
type Source struct {
	N     int
	Title string
	URL   string
	// Quote is the passage, shown with --show quotes.
	Quote string
}

// Sources writes the Sources block: number, document and page, the link, and optionally the quoted passage. Without
// a terminal it is a plain Markdown list.
func (u *UI) Sources(sources []Source, tty bool) string {
	if len(sources) == 0 {
		return ""
	}
	var b strings.Builder
	if !tty {
		b.WriteString("Sources:\n\n")
		for _, s := range sources {
			fmt.Fprintf(&b, "- [%d] %s", s.N, s.Title)
			if s.URL != "" {
				fmt.Fprintf(&b, ": %s", s.URL)
			}
			b.WriteString("\n")
			if s.Quote != "" {
				fmt.Fprintf(&b, "  > %s\n", s.Quote)
			}
		}
		return b.String()
	}
	b.WriteString(u.S(Strong, "Sources") + "\n")
	for _, s := range sources {
		num := fmt.Sprintf("[%d]", s.N)
		fmt.Fprintf(&b, "  %s %s\n", u.S(Marker, num), s.Title)
		pad := strings.Repeat(" ", 3+DisplayWidth(num))
		if s.URL != "" {
			fmt.Fprintf(&b, "%s%s\n", pad, u.link(s.URL))
		}
		if s.Quote != "" {
			for _, l := range wrap(s.Quote, u.IO.ProseWidth()-len(pad)) {
				fmt.Fprintf(&b, "%s%s\n", pad, u.S(Quote, l))
			}
		}
	}
	return b.String()
}

// displayURL drops the scheme, as the mock-ups show links.
func displayURL(url string) string {
	return strings.TrimPrefix(strings.TrimPrefix(url, "https://"), "http://")
}

// link shows a URL without its scheme, as an OSC 8 link where the terminal shows them, otherwise in full and
// underlined.
func (u *UI) link(url string) string {
	if a, ok := u.Out.(ANSIStyler); ok && a.Links {
		return a.Hyperlink(url, displayURL(url))
	}
	return u.S(Link, url)
}
