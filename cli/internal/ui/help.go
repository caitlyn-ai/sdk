package ui

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
)

// Help renders a command's help in the order of the design's example (2.3): the summary, the description, usage,
// commands, flags, what it needs, examples, when it fails, and where it came from. Generated commands carry the
// last parts in their long help; it is split here, so hand-written commands with a plain description read the same.
func (u *UI) Help(cmd *cobra.Command) string {
	var b strings.Builder
	s := u.Out
	width := u.IO.ProseWidth()
	section := func(title string) {
		b.WriteString("\n" + s.Paint(Strong, title) + "\n")
	}
	short := strings.TrimSpace(cmd.Short)
	if short == "" {
		short = cmd.CommandPath()
	}
	b.WriteString(s.Paint(Strong, short) + "\n")
	parts := splitLong(cmd.Long)
	if parts.description != "" && strings.TrimSpace(parts.description) != short {
		b.WriteString("\n" + parts.description + "\n")
	}
	section("Usage:")
	if cmd.Runnable() {
		b.WriteString("  " + cmd.UseLine() + "\n")
	}
	if cmd.HasAvailableSubCommands() {
		b.WriteString("  " + cmd.CommandPath() + " <command> [flags]\n")
	}
	if len(cmd.Aliases) > 0 {
		section("Aliases:")
		b.WriteString("  " + strings.Join(append([]string{cmd.Name()}, cmd.Aliases...), ", ") + "\n")
	}
	var subs, topics []*cobra.Command
	for _, c := range cmd.Commands() {
		switch {
		case c.IsAdditionalHelpTopicCommand():
			topics = append(topics, c)
		case c.IsAvailableCommand():
			subs = append(subs, c)
		}
	}
	if len(subs) > 0 {
		section("Commands:")
		b.WriteString(u.nameList(subs, width))
	}
	if fl := flagLines(cmd.LocalFlags(), width); fl != "" {
		section("Flags:")
		b.WriteString(fl)
	}
	if cmd.HasParent() && cmd.HasAvailableInheritedFlags() {
		b.WriteString("\n" + s.Paint(Muted, "Global flags (--output, --profile, --query, --no-input, …): caitlyn --help") + "\n")
	}
	if parts.needs != "" {
		b.WriteString("\n" + strongHeading(s, parts.needs) + "\n")
	}
	if strings.TrimSpace(cmd.Example) != "" {
		section("Examples:")
		b.WriteString(strings.TrimRight(cmd.Example, "\n") + "\n")
	}
	if parts.fails != "" {
		b.WriteString("\n" + strongHeading(s, parts.fails) + "\n")
	}
	if len(topics) > 0 {
		section("Help topics:")
		b.WriteString(u.nameList(topics, width))
	}
	if parts.footer != "" {
		b.WriteString("\n" + parts.footer + "\n")
	}
	if !cmd.HasParent() {
		b.WriteString("\n" + s.Paint(Muted, "Exit codes: caitlyn help exit-codes") + "\n")
	}
	return b.String()
}

// strongHeading paints a section's first line (its heading) strong.
func strongHeading(s Styler, block string) string {
	head, rest, ok := strings.Cut(block, "\n")
	if !ok {
		return block
	}
	return s.Paint(Strong, head) + "\n" + rest
}

func (u *UI) nameList(cmds []*cobra.Command, width int) string {
	w := 0
	for _, c := range cmds {
		w = max(w, DisplayWidth(c.Name()))
	}
	w = min(w, 28)
	var b strings.Builder
	for _, c := range cmds {
		short := u.Truncate(c.Short, width-w-4)
		fmt.Fprintf(&b, "  %-*s  %s\n", w, c.Name(), short)
	}
	return b.String()
}

type longParts struct{ description, needs, fails, footer string }

// splitLong sorts a long help's paragraphs: the description; Needs, Impact and the app-only note (after the flags);
// When it fails (after the examples); and the availability and docs line (last).
func splitLong(long string) longParts {
	var p longParts
	add := func(to *string, block string) {
		if *to != "" {
			*to += "\n\n"
		}
		*to += block
	}
	for _, block := range strings.Split(strings.TrimSpace(long), "\n\n") {
		block = strings.Trim(block, "\n")
		if block == "" {
			continue
		}
		t := strings.TrimSpace(block)
		switch {
		case strings.HasPrefix(t, "Needs:"), strings.HasPrefix(t, "Impact:"), strings.HasPrefix(t, "Only in the Caitlyn app"):
			add(&p.needs, block)
		case strings.HasPrefix(t, "When it fails:"):
			add(&p.fails, block)
		case strings.HasPrefix(t, "Available from"), strings.HasPrefix(t, "https://"), strings.HasPrefix(t, "Docs:"):
			add(&p.footer, block)
		default:
			add(&p.description, block)
		}
	}
	return p
}

// flagLines lists flags: shorthand, name and value type, then the usage wrapped beside them. Boolean flags show no
// value (pflag's `[=true|false]` is noise), and defaults show only when they say something.
func flagLines(fs *pflag.FlagSet, width int) string {
	type row struct{ name, usage string }
	var rows []row
	fs.VisitAll(func(f *pflag.Flag) {
		if f.Hidden {
			return
		}
		varname, usage := pflag.UnquoteUsage(f)
		name := "      --" + f.Name
		if f.Shorthand != "" && f.ShorthandDeprecated == "" {
			name = "  -" + f.Shorthand + ", --" + f.Name
		}
		isBool := f.Value.Type() == "bool" || f.NoOptDefVal == "true" || f.NoOptDefVal == "false"
		if isBool {
			varname = ""
		}
		if varname != "" {
			name += " " + varname
		}
		if f.NoOptDefVal != "" && !isBool {
			name += "[=" + f.NoOptDefVal + "]"
		}
		if d := f.DefValue; !isBool && d != "" && d != "0" && d != "[]" && d != "<nil>" && !strings.Contains(usage, "(default") {
			usage += fmt.Sprintf(" (default %s)", d)
		}
		if f.Deprecated != "" {
			usage += " (deprecated: " + f.Deprecated + ")"
		}
		rows = append(rows, row{name, usage})
	})
	if len(rows) == 0 {
		return ""
	}
	col := 0
	for _, r := range rows {
		if w := DisplayWidth(r.name); w <= 34 {
			col = max(col, w)
		}
	}
	var b strings.Builder
	for _, r := range rows {
		usageW := max(30, width-col-2)
		lines := wrap(r.usage, usageW)
		if DisplayWidth(r.name) > col {
			b.WriteString(r.name + "\n")
			for _, l := range lines {
				b.WriteString(strings.Repeat(" ", col+2) + l + "\n")
			}
			continue
		}
		for i, l := range lines {
			if i == 0 {
				b.WriteString(r.name + strings.Repeat(" ", col-DisplayWidth(r.name)+2) + l + "\n")
			} else {
				b.WriteString(strings.Repeat(" ", col+2) + l + "\n")
			}
		}
	}
	return b.String()
}

// ExitCodes writes the exit-code table (4.6) for `caitlyn help exit-codes`: a table on a terminal, tab-separated
// when piped.
func (u *UI) ExitCodes(w io.Writer, tty bool) {
	rows := make([][]Cell, 0, len(exitcode.Table))
	for _, e := range exitcode.Table {
		rows = append(rows, []Cell{{Text: fmt.Sprint(e.Code), Keep: true}, {Text: e.Meaning}, {Text: e.From, Role: Muted}})
	}
	u.Table(w, tty, []string{"Code", "Meaning", "From"}, rows, "")
}
