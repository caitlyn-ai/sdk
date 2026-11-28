package describe

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
)

// Register adds `commands`, `help`, `docs` and `mcp` to the root command. It is called once, from the commands
// package's registrations.
func Register() {
	root.AddCommands = append(root.AddCommands, func(r *cobra.Command, f *cmdutil.Factory) {
		r.AddCommand(newCommandsCmd(f))
		r.AddCommand(newDocsCmd(f))
		r.AddCommand(newMCPCmd(f))
		r.SetHelpCommand(newHelpCmd(f))
		installHelpFunc(r, f)
	})
}

// annotate marks one of this package's own commands with its impact and the exit codes it can end with, so the
// tree describes them as it describes every other command.
func annotate(c *cobra.Command, impact string, exitCodes string) *cobra.Command {
	if c.Annotations == nil {
		c.Annotations = map[string]string{}
	}
	c.Annotations[AnnotationImpact] = impact
	if exitCodes != "" {
		c.Annotations[AnnotationExitCodes] = exitCodes
	}
	return c
}

func newCommandsCmd(f *cmdutil.Factory) *cobra.Command {
	var asJSON, hidden bool
	c := &cobra.Command{
		Use:   "commands",
		Short: "Every command, with its flags, impact and exit codes",
		Long: `Prints the whole command tree of this CLI, hand-written commands included.

On a terminal it is a tree. With --output json (or --json, and whenever the output is not a terminal) it is one
JSON document for AI agents and scripts: every command's flags with their types, enum values and whether they are
required; its impact class (read, write, user-facing or destructive); whether it is long-running, interactive-only
or beta; the permission and scope it needs; the exit codes it can end with, and the error codes behind them; its
examples as command lines; and its page in the docs. It also has the exit-code table, the global flags, whether
the CLI is in agent mode, and the MCP servers that suit some work better than the CLI (alternatives.mcp).

It describes the CLI that is installed, so it always matches the version that runs.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			t := Build(cmd.Root(), f, Options{IncludeHidden: hidden})
			format, err := output.Resolve(f)
			if err != nil {
				return err
			}
			if asJSON {
				format = output.JSON
			}
			return printTree(f, cmd, t, format)
		},
	}
	c.Flags().BoolVar(&asJSON, "json", false, "Print JSON (the same as --output json)")
	c.Flags().BoolVar(&hidden, "hidden", false, "Include the commands help doesn't list (the low-level core group)")
	return annotate(c, "read", "")
}

// printTree prints the tree in the chosen format: JSON (or YAML) for machines, an indented tree for people.
func printTree(f *cmdutil.Factory, cmd *cobra.Command, t *Tree, format string) error {
	if f.Globals.JQ != "" || f.Globals.Query != "" {
		return printData(f, t)
	}
	switch format {
	case output.JSON, output.JSONL:
		return writeJSON(f.IO.Out, t)
	case output.YAML:
		return writeYAML(f.IO.Out, t)
	}
	writeTreeText(f.IO.Out, t)
	return nil
}

// printData prints data this package made, as JSON, through --jq or --query when given: a string result as itself,
// anything else as JSON (indented on a terminal), one result per line, as every other command does.
func printData(f *cmdutil.Factory, v any) error {
	if f.Globals.JQ == "" && f.Globals.Query == "" {
		return writeJSON(f.IO.Out, v)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data, err := output.Decode(b)
	if err != nil {
		return err
	}
	results, err := output.Apply(data, f.Globals.JQ, f.Globals.Query)
	if err != nil {
		return cmdutil.Usagef("%v", err)
	}
	for _, r := range results {
		if s, ok := r.(string); ok {
			fmt.Fprintln(f.IO.Out, s)
			continue
		}
		var out []byte
		if f.IO.IsStdoutTTY() {
			out, err = json.MarshalIndent(r, "", "  ")
		} else {
			out, err = json.Marshal(r)
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(f.IO.Out, "%s\n", out)
	}
	return nil
}

func writeJSON(w io.Writer, v any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return err
	}
	_, err := w.Write(buf.Bytes())
	return err
}

func writeYAML(w io.Writer, v any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	n, err := output.JSONToYAMLNode(buf.Bytes())
	if err != nil {
		return err
	}
	return yamlEncode(w, n)
}

// writeTreeText is the tree for people: each command indented under its group, with its summary, marked when it is
// beta, long-running, user-facing or destructive.
func writeTreeText(w io.Writer, t *Tree) {
	width := 0
	for _, c := range t.Commands {
		if n := 2*(len(c.Path)-1) + len(c.Path[len(c.Path)-1]); n > width {
			width = n
		}
	}
	if width > 44 {
		width = 44
	}
	for _, c := range t.Commands {
		name := strings.Repeat("  ", len(c.Path)-1) + c.Path[len(c.Path)-1]
		var marks []string
		if c.Stability != "" {
			marks = append(marks, c.Stability)
		}
		if c.Impact == "user-facing" || c.Impact == "destructive" {
			marks = append(marks, c.Impact)
		}
		if c.InteractiveOnly {
			marks = append(marks, "interactive only")
		}
		summary := c.Summary
		if len(marks) > 0 {
			summary += "  [" + strings.Join(marks, ", ") + "]"
		}
		pad := width - len(name)
		if pad < 1 {
			pad = 1
		}
		fmt.Fprintf(w, "%s%s  %s\n", name, strings.Repeat(" ", pad), summary)
	}
	fmt.Fprintf(w, "\nOne command: caitlyn help <command>. As JSON for scripts and AI agents: caitlyn commands --json\n")
}

// Print prints data another package made as this package prints its own: YAML for --output yaml, else JSON, through
// --jq or --query when given.
func Print(f *cmdutil.Factory, v any) error {
	if format, _ := output.Resolve(f); format == output.YAML && f.Globals.JQ == "" && f.Globals.Query == "" {
		return writeYAML(f.IO.Out, v)
	}
	return printData(f, v)
}

// Annotate marks a command another package adds with its impact and exit codes, as this package marks its own.
func Annotate(c *cobra.Command, impact, exitCodes string) *cobra.Command {
	return annotate(c, impact, exitCodes)
}
