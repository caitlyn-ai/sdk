package commands

import (
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/emblem"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/pager"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// The design system (section 12): the background query, the spinner, prompts, the pager, the emblem's welcome
// screen, and the help template.
func init() { registrations = append(registrations, registerUI) }

func registerUI() {
	prevSettings := root.UISettings
	root.UISettings = func(f *cmdutil.Factory, s *ui.Settings) {
		prevSettings(f, s)
		if s.QueryBackground == nil {
			s.QueryBackground = func() string { return ui.QueryBackground(ui.SystemQuerier(f.IO)) }
		}
	}
	gen.Spinner = func(f *cmdutil.Factory, u interface{}, label string) func() {
		uu, ok := u.(*ui.UI)
		if !ok {
			uu = gen.UIFor(f)
		}
		return uu.StartSpinner(f, label).Stop
	}
	root.Welcome = emblem.Welcome
	pager.Install()
	pager.SetUI(func(f *cmdutil.Factory) *ui.UI { return gen.UIFor(f) })
	root.BeforeRun = append(root.BeforeRun, func(f *cmdutil.Factory, cmd *cobra.Command) {
		accessible := false
		if cfg, err := f.Config(); err == nil && cfg != nil {
			accessible = cfg.Bool("accessible")
		}
		u := gen.UIFor(f)
		// huh draws on a real terminal; streams that only say they are one (tests, recordings) keep the plain prompts
		if _, real := f.IO.In.(*os.File); !real {
			return
		}
		prompt.SetPrompter(func(*iostreams.IOStreams) prompt.Prompter { return &ui.Prompter{U: u, Accessible: accessible} })
	})
	root.AddCommands = append(root.AddCommands, addHelp)
}

// addHelp installs the help template (2.3). `caitlyn help` itself, its --format json|markdown, and its agents and
// exit-codes topics are the describe package's; help as data (-o json) still goes through its help function.
func addHelp(r *cobra.Command, f *cmdutil.Factory) {
	asData := r.HelpFunc()
	r.SetHelpFunc(func(cmd *cobra.Command, args []string) {
		if strings.EqualFold(f.Globals.Output, output.JSON) {
			asData(cmd, args)
			return
		}
		// --help is answered before the root's preparation runs: set the design system up here, the same way
		root.SetupUI(f)
		_ = pager.Page(f, gen.UIFor(f).Help(cmd))
	})
}
