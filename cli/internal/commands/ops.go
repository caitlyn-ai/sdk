package commands

import (
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/ci/cisession"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/telemetrycmd"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/updatecmd"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/versioncmd"
	"github.com/caitlyn-ai/sdk/cli/internal/telemetry"
)

// The CI reporters' global flags and session (15), usage data for Caitlyn (9.1), the updater and its notice (8.4), and
// `caitlyn version` (8.1).
func init() {
	registrations = append(registrations, func() {
		root.AddCommands = append(root.AddCommands, cisession.Register, telemetry.Register, telemetrycmd.Add, updatecmd.Add, versioncmd.Add)
		root.BeforeRun = append(root.BeforeRun, cisession.BeforeRun, telemetry.BeforeRun, updatecmd.BeforeRun)
		root.AfterRun = append(root.AfterRun,
			func(f *cmdutil.Factory, cmd *cobra.Command, code int, took time.Duration) {
				cisession.AfterRun(f, code)
			},
			updatecmd.AfterRun,
			// Last, so the event's duration includes the rest
			telemetry.AfterRun,
		)
	})
}
