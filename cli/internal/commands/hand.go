package commands

import (
	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/configcmd"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/hand"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

func init() {
	registrations = append(registrations, func() {
		root.AddCommands = append(root.AddCommands, addHandWritten)
	})
}

// group returns the noun command at path under root, making it (and its aliases) when missing, so the generated
// commands land beside the hand-written ones.
func group(root *cobra.Command, path ...string) *cobra.Command {
	o := spec.MustOverlay()
	cur := root
	for i, noun := range path {
		var next *cobra.Command
		for _, c := range cur.Commands() {
			if c.Name() == noun {
				next = c
			}
		}
		if next == nil {
			key := ""
			for j, p := range path[:i+1] {
				if j > 0 {
					key += " "
				}
				key += p
			}
			next = &cobra.Command{Use: noun, Short: "Work with " + noun, Aliases: o.Aliases[key], Args: cobra.NoArgs,
				RunE: func(cmd *cobra.Command, args []string) error { return cmd.Help() }}
			cur.AddCommand(next)
		}
		cur = next
	}
	return cur
}

func addHandWritten(r *cobra.Command, f *cmdutil.Factory) {
	r.AddCommand(configcmd.New(f, func() *ui.UI { return gen.UIFor(f) }))
	r.AddCommand(hand.NewChat(f))
	r.AddCommand(hand.NewExport(f), hand.NewDiff(f), hand.NewApply(f))
	group(r, "events").AddCommand(hand.NewEventsTail(f))
	group(r, "knowledge-bases").AddCommand(hand.NewSync(f))
	draft := group(r, "agents", "draft")
	draft.Short = "An agent's draft: the version you edit"
	draft.AddCommand(hand.NewDraftEdit(f), hand.NewDraftDiff(f))
}
