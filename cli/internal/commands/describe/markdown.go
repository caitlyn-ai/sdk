package describe

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
)

// Site is the developer docs' address. Links in the Markdown are absolute, so `caitlyn help --format markdown` reads
// the same pasted anywhere; the docs build makes them site-relative and checks each one names a page.
const Site = "https://build.caitlyn.ai"

// ImpactText says what each impact class means, for help and the docs (18.5).
var ImpactText = map[string]string{
	"read":        "reads only",
	"write":       "changes drafts or your own work",
	"user-facing": "changes what other people get; AI agents and CI pass `--yes`",
	"destructive": "can't be undone; asks first, and AI agents and CI pass `--yes`",
}

var callerWords = map[string]string{"person": "people", "api_client": "API clients", "guest": "guests"}

// Kebab is the docs' page name for an operation (SaveDraftVersion gives save-draft-version), as the SDK and HTTP
// API references spell it.
func Kebab(name string) string {
	s := regexp.MustCompile(`([a-z0-9])([A-Z])`).ReplaceAllString(name, "$1-$2")
	s = regexp.MustCompile(`([A-Z])([A-Z][a-z])`).ReplaceAllString(s, "$1-$2")
	return strings.ToLower(s)
}

// SchemaURL is where the docs publish a command's input or output schema ("input" or "output").
func SchemaURL(path []string, which string) string {
	return Site + "/cli/schemas/" + strings.Join(path, "-") + "." + which + ".json"
}

// Markdown is one command's reference, as its section on the command's page has it and `caitlyn help <command>
// --format markdown` prints it. level is the heading level of the command's own heading (1 on its own, 2 as a
// section of its group's page).
func Markdown(d *Command, t *Tree, level int) string {
	h := func(n int) string { return strings.Repeat("#", level+n) + " " }
	var b strings.Builder
	if d.Kind == "group" {
		return groupMarkdown(d, t, level)
	}
	title := d.Path[len(d.Path)-1]
	if level == 1 {
		title = "caitlyn " + d.Name
	}
	b.WriteString(h(0) + title + "\n\n")
	summary := d.Summary
	if d.Beta {
		summary += " (beta)"
	}
	b.WriteString(prose(sentence(summary)) + "\n\n")
	b.WriteString("```sh\n" + d.Usage + "\n```\n\n")
	if d.Description != "" && d.Description != d.Summary {
		b.WriteString(prose(d.Description) + "\n\n")
	}
	if len(d.Aliases) > 0 {
		fmt.Fprintf(&b, "Also: %s.\n\n", codeList(prefixAll("caitlyn "+strings.Join(d.Path[:len(d.Path)-1], " ")+" ", d.Aliases)))
	}
	b.WriteString(factsTable(d))
	if len(d.Args) > 0 {
		b.WriteString(h(1) + "Arguments\n\n")
		b.WriteString("| Argument | Description |\n| --- | --- |\n")
		for _, a := range d.Args {
			fmt.Fprintf(&b, "| `<%s>` | %s |\n", a.Name, argText(a))
		}
		b.WriteString("\n")
	}
	b.WriteString(h(1) + "Flags\n\n")
	if len(d.Flags) == 0 {
		b.WriteString("Only the [global flags](" + Site + "/cli/reference/#global-flags).\n\n")
	} else {
		b.WriteString(flagTable(d.Flags))
		b.WriteString("\nAnd the [global flags](" + Site + "/cli/reference/#global-flags).\n\n")
	}
	if len(d.Examples) > 0 {
		b.WriteString(h(1) + "Examples\n\n```sh\n")
		for i, ex := range d.Examples {
			if i > 0 {
				b.WriteString("\n")
			}
			if ex.Title != "" || ex.Error != "" {
				fmt.Fprintf(&b, "# %s", strings.TrimSuffix(ex.Title, "."))
				if ex.Error != "" {
					fmt.Fprintf(&b, ": fails with %s, exit code %d", ex.Error, ex.ExitCode)
				}
				b.WriteString("\n")
			}
			b.WriteString(ex.Line + "\n")
		}
		b.WriteString("```\n\n")
	}
	b.WriteString(h(1) + "Exit codes\n\n")
	b.WriteString(exitTable(d))
	return strings.TrimRight(b.String(), "\n") + "\n"
}

func groupMarkdown(d *Command, t *Tree, level int) string {
	var b strings.Builder
	h := strings.Repeat("#", level) + " "
	title := d.Path[len(d.Path)-1]
	if level == 1 {
		title = "caitlyn " + d.Name
	}
	b.WriteString(h + title + "\n\n")
	b.WriteString(prose(sentence(d.Summary)) + "\n\n")
	b.WriteString("```sh\ncaitlyn " + d.Name + " <command> [flags]\n```\n\n")
	if len(d.Aliases) > 0 {
		fmt.Fprintf(&b, "Also: %s.\n\n", codeList(prefixAll("caitlyn "+strings.Join(d.Path[:len(d.Path)-1], " ")+" ", d.Aliases)))
	}
	if d.Description != "" && d.Description != d.Summary {
		b.WriteString(prose(d.Description) + "\n\n")
	}
	if len(d.Examples) > 0 {
		b.WriteString("```sh\n")
		for _, ex := range d.Examples {
			if ex.Title != "" {
				b.WriteString("# " + strings.TrimSuffix(ex.Title, ".") + "\n")
			}
			b.WriteString(ex.Line + "\n")
		}
		b.WriteString("```\n\n")
	}
	b.WriteString("| Command | Description |\n| --- | --- |\n")
	for _, name := range d.Subcommands {
		sub := t.Find(append(append([]string{}, d.Path...), name))
		if sub == nil {
			continue
		}
		fmt.Fprintf(&b, "| [`caitlyn %s`](%s) | %s |\n", sub.Name, sub.Docs, cell(prose(sentence(sub.Summary))))
	}
	return b.String()
}

// Find returns the command at path, or nil.
func (t *Tree) Find(path []string) *Command {
	name := strings.Join(path, " ")
	for _, c := range t.Commands {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func factsTable(d *Command) string {
	var rows [][2]string
	if d.Impact != "" {
		v := fmt.Sprintf("`%s`: %s", d.Impact, ImpactText[d.Impact])
		if d.Confirm != "" {
			v += fmt.Sprintf("; AI agents and CI also pass `--confirm <%s>`", d.Confirm)
		}
		rows = append(rows, [2]string{"Impact", v})
	}
	if p := d.Permission; p != nil {
		var v string
		switch {
		case p.Action != "" && p.Scope != "":
			v = fmt.Sprintf("`%s` (scope `%s`)", p.Action, p.Scope)
		case p.Action != "":
			v = fmt.Sprintf("`%s`", p.Action)
		default:
			v = fmt.Sprintf("the scope `%s`", p.Scope)
		}
		if p.Grant != "" {
			v += " and " + p.Grant + "; returns 404 when it isn't shared with you"
		}
		rows = append(rows, [2]string{"Needs", v})
		if len(p.Callers) > 0 {
			var who []string
			for _, c := range p.Callers {
				if w, ok := callerWords[c]; ok {
					who = append(who, w)
				}
			}
			if len(who) > 0 {
				rows = append(rows, [2]string{"Who can run it", sentence(joinAnd(who))})
			}
		}
	}
	if d.InteractiveOnly {
		rows = append(rows, [2]string{"Interactive only", "Only in the Caitlyn app while signed in: no token can call it, the CLI's included. The CLI refuses it before sending, with exit code 5"})
	}
	if d.Beta {
		rows = append(rows, [2]string{"Stability", "Beta: it may change before it is generally available"})
	} else if d.Generated && d.Operation != "" {
		rows = append(rows, [2]string{"Stability", "Generally available"})
	}
	if d.Since != "" {
		rows = append(rows, [2]string{"Since", "Caitlyn " + d.Since})
	}
	if d.Stream {
		rows = append(rows, [2]string{"Output", "A stream of events: one JSON object per event with `--output jsonl`"})
	}
	if d.LongRunning && !d.Stream {
		rows = append(rows, [2]string{"Long-running", "Waits with `--wait` (where it starts work) and `--timeout`; AI agents get a 4-minute default and a command that resumes the wait"})
	}
	if d.Operation != "" {
		rows = append(rows, [2]string{"In the SDKs", fmt.Sprintf("[`%s`](%s/sdk/%s/)", d.SDK, Site, Kebab(d.Operation))})
		if d.HTTP != nil {
			rows = append(rows, [2]string{"In the HTTP API", fmt.Sprintf("[`%s %s`](%s/api/%s/)", d.HTTP.Method, d.HTTP.Path, Site, Kebab(d.Operation))})
		}
		schemas := fmt.Sprintf("[input](%s)", SchemaURL(d.Path, "input"))
		if !d.Stream {
			schemas += fmt.Sprintf(" and [output](%s)", SchemaURL(d.Path, "output"))
		}
		rows = append(rows, [2]string{"JSON Schema", schemas + fmt.Sprintf("; `caitlyn help %s --format json` prints them too", d.Name)})
	} else if len(d.Operations) > 0 {
		var links []string
		for _, op := range d.Operations {
			links = append(links, fmt.Sprintf("[%s](%s/api/%s/)", op, Site, Kebab(op)))
		}
		rows = append(rows, [2]string{"Calls", joinAnd(links)})
	} else if d.SDK != "" {
		rows = append(rows, [2]string{"In the SDKs", fmt.Sprintf("`%s`", d.SDK)})
	}
	if len(rows) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("| | |\n| --- | --- |\n")
	for _, r := range rows {
		fmt.Fprintf(&b, "| %s | %s |\n", r[0], cell(r[1]))
	}
	b.WriteString("\n")
	return b.String()
}

func argText(a *Arg) string {
	var parts []string
	switch {
	case a.File:
		parts = append(parts, "The file to upload, or `-` for stdin with `--file-name`.")
	case a.Identifier != "":
		what := strings.ReplaceAll(Kebab(strings.TrimSuffix(a.Identifier, "Id")), "-", " ")
		parts = append(parts, sentence("the "+what)+".")
		if a.Version {
			parts = append(parts, "Written `AGENT` or `AGENT@version`: `AGENT` alone means its live version, `AGENT@draft` its draft.")
		}
	default:
		parts = append(parts, sentence(a.Name)+".")
	}
	if a.Required {
		parts = append(parts, "Required.")
	} else {
		parts = append(parts, "Optional.")
	}
	if a.Repeatable {
		parts = append(parts, "Repeatable.")
	}
	return strings.Join(parts, " ")
}

// flagTable is a command's flags: name (and short forms), type, and what it does with its limits.
func flagTable(flags []*Flag) string {
	var b strings.Builder
	b.WriteString("| Flag | Type | Description |\n| --- | --- | --- |\n")
	for _, f := range flags {
		if f.Hidden {
			continue
		}
		names := []string{"`--" + f.Name + "`"}
		if f.Shorthand != "" {
			names = append([]string{"`-" + f.Shorthand + "`"}, names...)
		}
		for _, a := range f.Aliases {
			names = append(names, "`--"+a+"`")
		}
		fmt.Fprintf(&b, "| %s | %s | %s |\n", strings.Join(names, ", "), flagType(f), cell(flagText(f)))
	}
	return b.String()
}

func flagType(f *Flag) string {
	t := f.ValueType
	if t == "" {
		switch f.Type {
		case "stringArray", "stringSlice":
			t = "string, repeatable"
		default:
			t = f.Type
		}
	} else if f.Repeatable {
		t += ", repeatable"
	}
	if f.Required {
		t += ", required"
	}
	return t
}

func flagText(f *Flag) string {
	parts := []string{prose(sentence(strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(f.Description, " (required)"), ".")) + "."))}
	if len(f.Enum) > 0 && !strings.Contains(f.Description, "One of:") && f.Name != "clear" {
		parts = append(parts, "One of: "+codeList(f.Enum)+".")
	}
	if f.Min != nil || f.Max != nil {
		parts = append(parts, "From "+bound(f.Min, "any")+" to "+bound(f.Max, "any")+".")
	}
	if f.MaxLength != nil {
		parts = append(parts, fmt.Sprintf("At most %s characters.", bound(f.MaxLength, "")))
	}
	if f.Pattern != "" {
		parts = append(parts, "Matches `"+f.Pattern+"`.")
	}
	if f.Default != "" {
		parts = append(parts, "Default: `"+f.Default+"`.")
	}
	if f.NoOptValue != "" {
		parts = append(parts, fmt.Sprintf("Given alone, `%s`.", f.NoOptValue))
	}
	if f.Env != "" {
		parts = append(parts, "Environment: `"+f.Env+"`.")
	}
	if f.Secret {
		parts = append(parts, "A secret: never a flag value, so it stays out of shell history.")
	}
	if f.Impact != "" {
		parts = append(parts, "With it, the command's impact is `"+f.Impact+"`.")
	}
	return strings.Join(parts, " ")
}

func bound(v *float64, none string) string {
	if v == nil {
		return none
	}
	if *v == float64(int64(*v)) {
		return fmt.Sprintf("%d", int64(*v))
	}
	return fmt.Sprintf("%g", *v)
}

// exitTable lists every exit code the command can end with, and the error codes that end it with each.
func exitTable(d *Command) string {
	meaning := map[int]string{}
	for _, e := range exitcode.Table {
		meaning[e.Code] = e.Meaning
	}
	byExit := map[int][]string{}
	for _, e := range d.Errors {
		byExit[e.ExitCode] = append(byExit[e.ExitCode], fmt.Sprintf("`%s` (%d)", e.Code, e.Status))
	}
	var b strings.Builder
	b.WriteString("| Exit code | Meaning | Error codes |\n| --- | --- | --- |\n")
	codes := append([]int(nil), d.ExitCodes...)
	sort.Ints(codes)
	for _, c := range codes {
		fmt.Fprintf(&b, "| %d | %s | %s |\n", c, cell(meaning[c]), strings.Join(byExit[c], ", "))
	}
	b.WriteString("\nEvery error is printed on stderr with a hint of what to run next ([Exit codes](" + Site + "/cli/exit-codes/)). Each error code's page, `" + Site + "/errors/<CODE>/`, says what it means and what to do; [Errors](" + Site + "/cli/errors/) lists them all.\n")
	return b.String()
}

// ExitCodesMarkdown is the exit-code table, as `caitlyn help exit-codes --format markdown` prints it.
func ExitCodesMarkdown() string {
	var b strings.Builder
	b.WriteString("| Exit code | Meaning | From |\n| --- | --- | --- |\n")
	for _, e := range exitcode.Table {
		fmt.Fprintf(&b, "| %d | %s | %s |\n", e.Code, cell(e.Meaning), cell(e.From))
	}
	return b.String()
}

// prose makes help text safe as Markdown: a placeholder such as <workspace> outside code would be read as an HTML
// tag and vanish from the page (https://<workspace>/api/mcp showing as https:///api/mcp), so its < is escaped. Code
// spans and fenced blocks are left as they are.
func prose(s string) string {
	var b strings.Builder
	fence := false
	for i, line := range strings.Split(s, "\n") {
		if i > 0 {
			b.WriteString("\n")
		}
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			fence = !fence
			b.WriteString(line)
			continue
		}
		if fence {
			b.WriteString(line)
			continue
		}
		code := false
		for j := 0; j < len(line); j++ {
			c := line[j]
			switch {
			case c == '`':
				code = !code
			case c == '\\' && j+1 < len(line):
				b.WriteByte(c)
				j++
				c = line[j]
			case c == '<' && !code && placeholder.MatchString(line[j:]):
				b.WriteString("\\<")
				continue
			}
			b.WriteByte(c)
		}
	}
	return b.String()
}

// placeholder is the start of something written <name>, <name[@version]> or <a|b>: never an HTML tag in help text.
var placeholder = regexp.MustCompile(`^<[A-Za-z][\w@.\[\]|-]*>`)

func cell(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(s), "\n", " "), "|", `\|`)
}

func sentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func codeList(vals []string) string {
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = "`" + v + "`"
	}
	return strings.Join(out, ", ")
}

func prefixAll(prefix string, vals []string) []string {
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = strings.Join(strings.Fields(prefix+v), " ")
	}
	return out
}

func joinAnd(l []string) string {
	switch len(l) {
	case 0:
		return ""
	case 1:
		return l[0]
	}
	return strings.Join(l[:len(l)-1], ", ") + " and " + l[len(l)-1]
}

// PageMarkdown is a page of the command reference, title included: a group's page (its summary, a table of its
// commands, then a section for each: a command's full reference, or a group's summary and a link to its page), or a
// top-level command's own page. `caitlyn help <group> --format markdown` prints the same.
func PageMarkdown(d *Command, t *Tree) string {
	if d.Kind != "group" {
		return Markdown(d, t, 1)
	}
	var b strings.Builder
	b.WriteString(groupMarkdown(d, t, 1))
	for _, name := range d.Subcommands {
		sub := t.Find(append(append([]string{}, d.Path...), name))
		if sub == nil {
			continue
		}
		b.WriteString("\n")
		if sub.Kind == "group" {
			fmt.Fprintf(&b, "## %s\n\n%s See [`caitlyn %s`](%s): %s.\n", name, sentence(sub.Summary)+".", sub.Name, GroupOrPage(sub), codeList(sub.Subcommands))
			continue
		}
		b.WriteString(Markdown(sub, t, 2))
	}
	return b.String()
}

// Page is one page of the command reference, as the docs build publishes it.
type Page struct {
	// Path is the group's or command's path; the page is /cli/reference/<path joined by />/.
	Path  []string `json:"path"`
	Title string   `json:"title"`
	// Summary is the page's one-line description.
	Summary string `json:"summary"`
	// Markdown is the page without its title.
	Markdown string `json:"markdown"`
	// Commands are the commands the page documents in full, Operations the API operations behind them.
	Commands   []string `json:"commands"`
	Operations []string `json:"operations"`
	Hidden     bool     `json:"hidden,omitempty"`
}

// PageBudget is the most a reference page's Markdown may hold, in characters: about 4,000 tokens, so an AI agent
// can fetch only the commands it needs (20.2). A group's page over it gives each command a page of its own.
const PageBudget = 16000

// Pages are the command reference's pages: one per group, and one per top-level command that is not a group. A
// group whose page would be over PageBudget keeps a short section per command (so each command's address,
// /cli/reference/<group>/#<command>, still lands on it) and gives each command its own page under the group's.
func Pages(t *Tree) []*Page {
	var out []*Page
	for _, c := range t.Commands {
		if c.Kind != "group" && len(c.Path) != 1 {
			continue
		}
		p := &Page{Path: c.Path, Title: "caitlyn " + c.Name, Summary: sentence(c.Summary), Hidden: c.Hidden}
		md := untitled(PageMarkdown(c, t))
		if c.Kind != "group" {
			p.Markdown = md
			addCommand(p, c)
			p.Operations = unique(p.Operations)
			out = append(out, p)
			continue
		}
		var leaves []*Command
		for _, name := range c.Subcommands {
			if sub := t.Find(append(append([]string{}, c.Path...), name)); sub != nil && sub.Kind != "group" {
				leaves = append(leaves, sub)
			}
		}
		if len(md) <= PageBudget {
			p.Markdown = md
			for _, l := range leaves {
				addCommand(p, l)
			}
			p.Operations = unique(p.Operations)
			out = append(out, p)
			continue
		}
		p.Markdown = untitled(splitGroupMarkdown(c, t))
		// The page summarises every command of the group, so it names their operations too
		for _, l := range leaves {
			if l.Operation != "" {
				p.Operations = append(p.Operations, l.Operation)
			}
		}
		p.Operations = unique(p.Operations)
		out = append(out, p)
		for _, l := range leaves {
			vp := &Page{Path: l.Path, Title: "caitlyn " + l.Name, Summary: sentence(l.Summary), Markdown: untitled(Markdown(l, t, 1)), Hidden: l.Hidden}
			addCommand(vp, l)
			vp.Operations = unique(vp.Operations)
			out = append(out, vp)
		}
	}
	return out
}

// CommandPage is the address of the page that documents a command in full: its own page when its group's page was
// split (pages from Pages), else its section on its group's page.
func CommandPage(pages []*Page, d *Command) string {
	for _, p := range pages {
		if strings.Join(p.Path, " ") == d.Name && d.Kind != "group" && len(d.Path) > 1 {
			return Site + "/cli/reference/" + strings.Join(d.Path, "/") + "/"
		}
	}
	return d.Docs
}

func addCommand(p *Page, d *Command) {
	p.Commands = append(p.Commands, d.Name)
	if d.Operation != "" {
		p.Operations = append(p.Operations, d.Operation)
	}
	p.Operations = append(p.Operations, d.Operations...)
}

// untitled is a page's Markdown without its # title, which the docs build writes.
func untitled(md string) string {
	if i := strings.Index(md, "\n"); strings.HasPrefix(md, "# ") && i > 0 {
		return strings.TrimLeft(md[i+1:], "\n")
	}
	return md
}

// splitGroupMarkdown is a large group's page: its summary and table, then for each command a short section (its
// summary, usage and impact) pointing to the command's own page, and for each group a pointer to its page.
func splitGroupMarkdown(d *Command, t *Tree) string {
	var b strings.Builder
	b.WriteString(groupMarkdown(d, t, 1))
	for _, name := range d.Subcommands {
		sub := t.Find(append(append([]string{}, d.Path...), name))
		if sub == nil {
			continue
		}
		b.WriteString("\n")
		if sub.Kind == "group" {
			fmt.Fprintf(&b, "## %s\n\n%s See [`caitlyn %s`](%s): %s.\n", name, sentence(sub.Summary)+".", sub.Name, GroupOrPage(sub), codeList(sub.Subcommands))
			continue
		}
		summary := sentence(sub.Summary)
		if sub.Beta {
			summary += " (beta)"
		}
		fmt.Fprintf(&b, "## %s\n\n%s.\n\n```sh\n%s\n```\n\n", name, strings.TrimSuffix(summary, "."), sub.Usage)
		if sub.Impact != "" {
			fmt.Fprintf(&b, "Impact: `%s`. ", sub.Impact)
		}
		fmt.Fprintf(&b, "Its flags, examples and exit codes: [`caitlyn %s`](%s/cli/reference/%s/).\n", sub.Name, Site, strings.Join(sub.Path, "/"))
	}
	return b.String()
}

func unique(l []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range l {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// Prose is prose, for tests and the docs build.
func Prose(s string) string { return prose(s) }
