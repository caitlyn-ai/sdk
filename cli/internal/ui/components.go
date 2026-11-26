package ui

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/x/ansi"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
)

// DisplayWidth is a string's width in terminal cells, ignoring escape sequences.
func DisplayWidth(s string) int { return ansi.StringWidth(s) }

func runeWidth(r rune) int { return ansi.StringWidth(string(r)) }

// Cell is one table cell.
type Cell struct {
	Text string
	Role Role
	// Keep: an identifier, never truncated.
	Keep bool
}

// Table draws a list (12.6): headers in upper case and muted, a hairline beneath, columns two spaces apart, no
// vertical rules. Identifiers are never truncated; other cells are, with an ellipsis, to fit the width. When w is not
// a terminal, columns are tab-separated and nothing is truncated, so the output can be cut and sorted.
func (u *UI) Table(w io.Writer, tty bool, headers []string, rows [][]Cell, footer string) {
	style := u.Out
	if !tty {
		for _, r := range rows {
			parts := make([]string, len(r))
			for i, c := range r {
				parts[i] = strings.ReplaceAll(c.Text, "\t", " ")
			}
			fmt.Fprintln(w, strings.Join(parts, "\t"))
		}
		return
	}
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = DisplayWidth(h)
	}
	for _, r := range rows {
		for i, c := range r {
			if i < len(widths) {
				widths[i] = max(widths[i], DisplayWidth(c.Text))
			}
		}
	}
	// Shrink the widest truncatable columns until the table fits
	total := func() int {
		t := 0
		for _, x := range widths {
			t += x
		}
		return t + 2*(len(widths)-1)
	}
	limit := u.IO.Width()
	for total() > limit {
		widest, at := 0, -1
		for i, x := range widths {
			keep := false
			for _, r := range rows {
				if i < len(r) && r[i].Keep {
					keep = true
					break
				}
			}
			if !keep && x > widest && x > 8 {
				widest, at = x, i
			}
		}
		if at < 0 {
			break
		}
		widths[at]--
	}
	var hb strings.Builder
	for i, h := range headers {
		if i > 0 {
			hb.WriteString("  ")
		}
		hb.WriteString(pad(style.Paint(Muted, strings.ToUpper(h)), DisplayWidth(h), widths[i], i == len(headers)-1))
	}
	fmt.Fprintln(w, strings.TrimRight(hb.String(), " "))
	fmt.Fprintln(w, style.Paint(Rule, strings.Repeat(u.G.Rule, min(total(), limit))))
	for _, r := range rows {
		var b strings.Builder
		for i, c := range r {
			if i >= len(widths) {
				break
			}
			if i > 0 {
				b.WriteString("  ")
			}
			text := c.Text
			if !c.Keep {
				text = u.Truncate(text, widths[i])
			}
			b.WriteString(pad(style.Paint(c.Role, text), DisplayWidth(text), widths[i], i == len(r)-1))
		}
		fmt.Fprintln(w, strings.TrimRight(b.String(), " "))
	}
	if footer != "" {
		fmt.Fprintln(w)
		fmt.Fprintln(w, style.Paint(Muted, footer))
	}
}

func pad(painted string, width, to int, last bool) string {
	if last || width >= to {
		return painted
	}
	return painted + strings.Repeat(" ", to-width)
}

// Row is one key-value row of a detail view.
type Row struct {
	Key   string
	Value string
	Role  Role
}

// Group is a short section of a detail view, with a lower-case label ("" for the first, unlabelled group).
type Group struct {
	Label string
	Rows  []Row
}

// Detail draws one thing (12.6): its name strong and its identifier muted, then key-value rows in groups.
func (u *UI) Detail(w io.Writer, title, id string, groups []Group, next string) {
	s := u.Out
	head := s.Paint(Strong, title)
	if id != "" && id != title {
		head += "  " + s.Paint(Muted, id)
	}
	fmt.Fprintln(w, head)
	keyW := 0
	for _, g := range groups {
		for _, r := range g.Rows {
			keyW = max(keyW, DisplayWidth(r.Key))
		}
	}
	for _, g := range groups {
		if len(g.Rows) == 0 {
			continue
		}
		fmt.Fprintln(w)
		if g.Label != "" {
			fmt.Fprintf(w, "  %s\n", s.Paint(Strong, g.Label))
		}
		for _, r := range g.Rows {
			val := r.Value
			indent := strings.Repeat(" ", 2+keyW+3)
			val = strings.ReplaceAll(val, "\n", "\n"+indent)
			fmt.Fprintf(w, "  %s   %s\n", pad(s.Paint(Muted, r.Key), DisplayWidth(r.Key), keyW, false), s.Paint(r.Role, val))
		}
	}
	if next != "" {
		fmt.Fprintln(w)
		fmt.Fprintln(w, s.Paint(Muted, u.G.Next+" "+next))
	}
}

// RenderError prints an error for people (12.9): what happened, why, the commands they may have meant, the
// command's usage, how to fix it, then the code, request ID and the error's page. It prints the error's human form
// (cmdutil.Error.ForPeople); the machine form is cmdutil.Error.JSON.
func (u *UI) RenderError(w io.Writer, e *cmdutil.Error) {
	var human cmdutil.HumanForm
	if e.Human != nil {
		human = *e.Human
	}
	e = e.ForPeople()
	s := u.Err
	fmt.Fprintf(w, "%s %s\n", s.Paint(Error, u.G.Failure), s.Paint(Strong, strings.TrimSpace(e.Title)))
	if e.Detail != "" && e.Detail != e.Title {
		fmt.Fprintln(w)
		for _, line := range wrap(e.Detail, u.IO.ProseWidth()-2) {
			fmt.Fprintf(w, "  %s\n", line)
		}
	}
	if len(e.Fields) > 0 {
		fmt.Fprintln(w)
		for _, f := range e.Fields {
			name := f.Flag
			if name == "" {
				name = f.Pointer
			}
			fmt.Fprintf(w, "  %s %s  %s\n", s.Paint(Error, u.G.Bullet), s.Paint(Strong, name), f.Detail)
		}
	}
	if len(human.Suggestions) > 0 {
		fmt.Fprintln(w)
		fmt.Fprintf(w, "  %s\n", "Did you mean this?")
		for _, c := range human.Suggestions {
			fmt.Fprintf(w, "      %s\n", c)
		}
	}
	if len(human.Usage) > 0 {
		fmt.Fprintln(w)
		fmt.Fprintf(w, "  %s\n", s.Paint(Muted, "Usage:"))
		for _, line := range human.Usage {
			fmt.Fprintf(w, "      %s\n", line)
		}
	}
	if e.Hint != nil {
		if len(e.Hint.Missing) > 0 {
			fmt.Fprintln(w)
			fmt.Fprintf(w, "  %s %s\n", s.Paint(Muted, u.G.Next), "Missing: "+strings.Join(e.Hint.Missing, ", "))
		}
		for _, n := range e.Hint.Next {
			fmt.Fprintln(w)
			fmt.Fprintf(w, "  %s %s:\n", s.Paint(Muted, u.G.Next), capitalise(n.Why))
			fmt.Fprintf(w, "      %s\n", n.Run)
		}
	}
	var meta []string
	if e.Status != 0 || e.Code != "" {
		meta = append(meta, strings.TrimSpace(fmt.Sprintf("%s %s", statusText(e.Status), e.Code)))
	}
	if e.RequestID != "" {
		meta = append(meta, "request "+e.RequestID)
	}
	if len(meta) > 0 || e.Type != "" {
		fmt.Fprintln(w)
	}
	if len(meta) > 0 {
		fmt.Fprintf(w, "  %s\n", s.Paint(Muted, strings.Join(meta, " "+u.G.Dot+" ")))
	}
	if e.Type != "" {
		fmt.Fprintf(w, "  %s\n", s.Hyperlink(e.Type, e.Type))
	}
	if e.Hint != nil && e.Hint.Docs != "" {
		fmt.Fprintf(w, "  %s\n", s.Paint(Muted, "docs: ")+s.Hyperlink(e.Hint.Docs, e.Hint.Docs))
	}
}

// RenderErrorLines prints the compact form AI agents read when output is text (18.2): one error line, then try: lines.
func (u *UI) RenderErrorLines(w io.Writer, e *cmdutil.Error) {
	head := "error: "
	if e.Code != "" {
		head += e.Code
		if e.Status != 0 {
			head += fmt.Sprintf(" (%d)", e.Status)
		}
		head += ": "
	}
	msg := e.Title
	if e.Detail != "" && e.Detail != e.Title {
		msg += " " + e.Detail
	}
	fmt.Fprintln(w, head+msg)
	for _, f := range e.Fields {
		name := f.Flag
		if name == "" {
			name = f.Pointer
		}
		fmt.Fprintf(w, "field: %s: %s\n", name, f.Detail)
	}
	if e.Hint != nil {
		if len(e.Hint.Missing) > 0 {
			fmt.Fprintf(w, "missing: %s\n", strings.Join(e.Hint.Missing, " "))
		}
		for _, n := range e.Hint.Next {
			fmt.Fprintf(w, "try: %s\n", n.Run)
		}
		if e.Hint.Docs != "" {
			fmt.Fprintf(w, "docs: %s\n", e.Hint.Docs)
		}
	}
	if e.RequestID != "" {
		fmt.Fprintf(w, "request: %s\n", e.RequestID)
	}
}

func statusText(s int) string {
	if s == 0 {
		return ""
	}
	return fmt.Sprint(s)
}

func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// wrap breaks prose at word boundaries to width cells.
func wrap(s string, width int) []string {
	if width < 20 {
		width = 20
	}
	var out []string
	for _, para := range strings.Split(s, "\n") {
		words := strings.Fields(para)
		line := ""
		for _, w := range words {
			switch {
			case line == "":
				line = w
			case DisplayWidth(line)+1+DisplayWidth(w) > width:
				out = append(out, line)
				line = w
			default:
				line += " " + w
			}
		}
		out = append(out, line)
	}
	return out
}

// Wrap is wrap for other packages.
func Wrap(s string, width int) []string { return wrap(s, width) }
