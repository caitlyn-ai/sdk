package describe

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

// Help formats.
const (
	FormatText     = "text"
	FormatJSON     = "json"
	FormatMarkdown = "markdown"
	FormatSkill    = "skill"
)

// HelpDoc is one command's help as data: `caitlyn help <command> --format json`.
type HelpDoc struct {
	SchemaVersion int      `json:"schemaVersion"`
	Command       *Command `json:"command"`
	// Subcommands of a group, described in full.
	Subcommands  []*Command `json:"subcommands,omitempty"`
	InputSchema  Schema     `json:"inputSchema,omitempty"`
	OutputSchema Schema     `json:"outputSchema,omitempty"`
	GlobalFlags  []*Flag    `json:"globalFlags"`
}

// HelpFor is one command's help as data.
func HelpFor(c *cobra.Command, f *cmdutil.Factory) *HelpDoc {
	m := spec.MustLoad()
	d := &HelpDoc{SchemaVersion: SchemaVersion, Command: Describe(c, f, m), GlobalFlags: flags(c.Root().PersistentFlags(), nil, true)}
	if g := gen.Of(c); g != nil && g.Op != nil {
		d.InputSchema = InputSchema(m, g.Op)
		if g.Op.SSE == nil {
			d.OutputSchema = OutputSchema(m, g.Op)
		}
	}
	if d.Command.Kind == "group" {
		for _, s := range c.Commands() {
			if Keep(s) && !s.Hidden {
				d.Subcommands = append(d.Subcommands, Describe(s, f, m))
			}
		}
	}
	return d
}

func newHelpCmd(f *cmdutil.Factory) *cobra.Command {
	var format, path string
	var write bool
	c := &cobra.Command{
		Use:   "help [command]...",
		Short: "Help for any command, as text, JSON or Markdown",
		Long: `Help for any command: caitlyn help agents draft save.

--format json prints it as data, with the input's JSON Schema; --format markdown prints the same Markdown as the
command's page in the docs.

Two topics are not commands:
  caitlyn help agents       The AGENTS.md section for AI coding agents (--format markdown), or a Claude Code
                            skill generated from this CLI (--format skill). --write writes it into this project.
                            For the agents commands themselves: caitlyn agents --help.
  caitlyn help exit-codes   What every exit code means.`,
		Args: cobra.ArbitraryArgs,
		ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
			target, _, _ := cmd.Root().Find(args)
			var out []string
			if len(args) == 0 {
				out = append(out, "agents", "exit-codes")
			}
			for _, s := range target.Commands() {
				if Keep(s) && !s.Hidden && strings.HasPrefix(s.Name(), toComplete) {
					out = append(out, s.Name())
				}
			}
			return out, cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			format = strings.ToLower(format)
			switch format {
			case "", FormatText, FormatJSON, FormatMarkdown, FormatSkill:
			default:
				return cmdutil.Usagef("--format takes text, json, markdown or skill, not %q", format)
			}
			if len(args) == 1 && args[0] == "agents" {
				return helpAgents(cmd, f, format, write, path)
			}
			if write {
				return cmdutil.Usagef("--write is only for caitlyn help agents")
			}
			if format == FormatSkill {
				return cmdutil.Usagef("--format skill is only for caitlyn help agents")
			}
			if len(args) == 1 && args[0] == "exit-codes" {
				return helpExitCodes(f, format)
			}
			target, rest, err := cmd.Root().Find(args)
			if err != nil || len(rest) > 0 || (len(args) > 0 && target == cmd.Root()) {
				e := cmdutil.Usagef("caitlyn %s is not a command.", strings.Join(args, " "))
				e.AddNext("caitlyn commands", "list every command")
				return e
			}
			switch format {
			case FormatJSON:
				return printData(f, HelpFor(target, f))
			case FormatMarkdown:
				t := Build(cmd.Root(), f, Options{IncludeHidden: true})
				if target == cmd.Root() {
					_, err := io.WriteString(f.IO.Out, ReferenceMarkdown(t, 1))
					return err
				}
				d := t.Find(PathOf(target))
				if d == nil {
					d = Describe(target, f, spec.MustLoad())
				}
				md := Markdown(d, t, 1)
				if d.Kind == "group" {
					md = PageMarkdown(d, t)
				}
				_, err := io.WriteString(f.IO.Out, md)
				return err
			}
			target.SetOut(f.IO.Out)
			return target.Help()
		},
	}
	c.Flags().StringVar(&format, "format", FormatText, "text, json or markdown; for caitlyn help agents, markdown or skill")
	c.Flags().BoolVar(&write, "write", false, "caitlyn help agents only: write the section into AGENTS.md, or the skill into .claude/skills/caitlyn/")
	c.Flags().StringVar(&path, "path", "", "With --write: the file (default AGENTS.md) or the skill's folder (default .claude/skills/caitlyn)")
	return annotate(c, "read", "")
}

// installHelpFunc makes `caitlyn <command> --help --output json` print the command's help as data, as
// `caitlyn help <command> --format json` does (10.2); any other --help is cobra's.
func installHelpFunc(r *cobra.Command, f *cmdutil.Factory) {
	plain := r.HelpFunc()
	r.SetHelpFunc(func(cmd *cobra.Command, args []string) {
		if strings.EqualFold(f.Globals.Output, output.JSON) {
			if err := printData(f, HelpFor(cmd, f)); err == nil {
				return
			}
		}
		plain(cmd, args)
	})
}

func helpExitCodes(f *cmdutil.Factory, format string) error {
	switch format {
	case FormatJSON:
		return printData(f, map[string]any{"schemaVersion": SchemaVersion, "exitCodes": exitcode.Table})
	case FormatMarkdown:
		_, err := io.WriteString(f.IO.Out, "# Exit codes\n\n"+ExitCodesMarkdown())
		return err
	}
	w := f.IO.Out
	fmt.Fprintln(w, "Exit codes: one table for every command. Scripts and AI agents can branch on them.")
	fmt.Fprintln(w)
	for _, e := range exitcode.Table {
		fmt.Fprintf(w, "  %3d  %s\n", e.Code, e.Meaning)
		if e.From != "" {
			fmt.Fprintf(w, "       From: %s\n", e.From)
		}
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Every machine-readable error carries its exitCode, and a hint of what to run next.")
	fmt.Fprintln(w, "More: https://build.caitlyn.ai/cli/exit-codes/")
	return nil
}

// helpAgents prints, or writes, the AGENTS.md section or the skill (18.4).
func helpAgents(cmd *cobra.Command, f *cmdutil.Factory, format string, write bool, path string) error {
	ws := workspaceOf(f)
	switch format {
	case "", FormatText, FormatMarkdown:
		snippet := AgentsSnippet(ws)
		if write {
			if path == "" {
				path = "AGENTS.md"
			}
			file, err := writeSnippet(f, path, snippet)
			if err != nil {
				return err
			}
			return reportWritten(f, []string{file})
		}
		_, err := io.WriteString(f.IO.Out, snippet)
		if err == nil && format != FormatMarkdown && f.IO.IsStdoutTTY() {
			fmt.Fprintln(f.IO.ErrOut, "\nAdd it to AGENTS.md (or CLAUDE.md) with: caitlyn help agents --write. For the agents commands: caitlyn agents --help")
		}
		return err
	case FormatJSON:
		t := Build(cmd.Root(), f, Options{})
		return printData(f, map[string]any{"schemaVersion": SchemaVersion, "snippet": AgentsSnippet(ws), "skill": Skill(t, ws)})
	}
	// FormatSkill
	t := Build(cmd.Root(), f, Options{})
	files := Skill(t, ws)
	if !write {
		for i, sf := range files {
			if i > 0 {
				fmt.Fprintln(f.IO.Out)
			}
			fmt.Fprintf(f.IO.Out, "<!-- %s -->\n%s", sf.Path, sf.Text)
		}
		return nil
	}
	if path == "" {
		path = filepath.Join(".claude", "skills", "caitlyn")
	}
	dir := resolve(f, path)
	var written []string
	for _, sf := range files {
		p := filepath.Join(dir, filepath.FromSlash(sf.Path))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return cmdutil.FromError(err)
		}
		if err := os.WriteFile(p, []byte(sf.Text), 0o644); err != nil {
			return cmdutil.FromError(err)
		}
		written = append(written, p)
	}
	return reportWritten(f, written)
}

func reportWritten(f *cmdutil.Factory, files []string) error {
	format, _ := output.Resolve(f)
	if format == output.JSON || format == output.JSONL {
		return writeJSON(f.IO.Out, map[string]any{"written": files})
	}
	for _, p := range files {
		fmt.Fprintf(f.IO.Out, "Wrote %s\n", p)
	}
	return nil
}

// resolve makes a path absolute against the working directory (the factory's, in tests).
func resolve(f *cmdutil.Factory, p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	dir := f.WorkDir
	if dir == "" {
		dir, _ = os.Getwd()
	}
	return filepath.Join(dir, p)
}

// writeSnippet puts the section into the file: in place of a "## Caitlyn CLI" section it already has, or at its end.
// Everything else in the file is kept as it was.
func writeSnippet(f *cmdutil.Factory, path, snippet string) (string, error) {
	p := resolve(f, path)
	old, err := os.ReadFile(p)
	if err != nil && !os.IsNotExist(err) {
		return "", cmdutil.FromError(err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", cmdutil.FromError(err)
	}
	return p, os.WriteFile(p, []byte(ReplaceSection(string(old), snippet)), 0o644)
}

// ReplaceSection replaces the document's "## Caitlyn CLI" section (to the next heading of the same or a higher
// level) with section, or appends section when there is none.
func ReplaceSection(doc, section string) string {
	lines := strings.Split(doc, "\n")
	start, end := -1, len(lines)
	fence := false
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			fence = !fence
		}
		if fence {
			continue
		}
		if start < 0 && strings.TrimSpace(l) == "## Caitlyn CLI" {
			start = i
			continue
		}
		if start >= 0 && (strings.HasPrefix(l, "## ") || strings.HasPrefix(l, "# ")) {
			end = i
			break
		}
	}
	section = strings.TrimRight(section, "\n") + "\n"
	if start < 0 {
		if strings.TrimSpace(doc) == "" {
			return section
		}
		return strings.TrimRight(doc, "\n") + "\n\n" + section
	}
	before := strings.Join(lines[:start], "\n")
	after := strings.Join(lines[end:], "\n")
	out := before
	if out != "" {
		out += "\n"
	}
	out += section
	if strings.TrimSpace(after) != "" {
		out += "\n" + after
	}
	return out
}

func yamlEncode(w io.Writer, n *yaml.Node) error {
	enc := yaml.NewEncoder(w)
	enc.SetIndent(2)
	if err := enc.Encode(n); err != nil {
		return err
	}
	return enc.Close()
}

// ReferenceMarkdown is the command reference's start page: every top-level command and group, and the global
// flags every command takes.
func ReferenceMarkdown(t *Tree, level int) string {
	var b strings.Builder
	h := strings.Repeat("#", level)
	if level == 1 {
		b.WriteString("# Command reference\n\n")
	}
	b.WriteString("Every command the CLI has, generated from the CLI itself. Each group has a page, with a section for each of its commands. `caitlyn commands --json` prints the same as data.\n\n")
	b.WriteString(h + "# Commands\n\n")
	b.WriteString("| Command | Description |\n| --- | --- |\n")
	for _, c := range t.Commands {
		if len(c.Path) != 1 || c.Hidden {
			continue
		}
		fmt.Fprintf(&b, "| [`caitlyn %s`](%s) | %s |\n", c.Name, GroupOrPage(c), cell(sentence(c.Summary)))
	}
	for _, c := range t.Commands {
		if len(c.Path) == 1 && c.Hidden {
			fmt.Fprintf(&b, "\nThe low-level building blocks are under [`caitlyn %s`](%s): commands most work never needs.\n", c.Name, GroupOrPage(c))
		}
	}
	b.WriteString("\n" + h + "# Global flags\n\n")
	b.WriteString("Every command takes these.\n\n")
	b.WriteString(flagTable(t.GlobalFlags))
	return b.String()
}

// GroupOrPage is a command's own page: a group's page, or a top-level command's.
func GroupOrPage(c *Command) string {
	if c.Kind == "group" {
		return gen.GroupDocsURL(c.Path)
	}
	return c.Docs
}
