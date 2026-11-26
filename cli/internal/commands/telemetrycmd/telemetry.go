// Package telemetrycmd is `caitlyn telemetry on|off|status [--pending]|reset|flush` (the CLI design, 9.1): usage data
// for Caitlyn only. Your own traces (package traces) have no command: OTEL_EXPORTER_OTLP_ENDPOINT turns them on.
package telemetrycmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/telemetry"
)

// HTTPClient is the flush's client (tests).
var HTTPClient *http.Client

// Add adds the telemetry commands. It is one of root.AddCommands.
func Add(root *cobra.Command, f *cmdutil.Factory) {
	cmd := &cobra.Command{
		Use:   "telemetry",
		Short: "Turn usage data for Caitlyn on or off, and see what it would send",
		Long: "Usage data for Caitlyn: the CLI can send Caitlyn anonymous usage data, which commands and flags run (never\n" +
			"their values), how long they take, and whether they succeed. Never arguments, IDs, content or anything about\n" +
			"you or your workspace. It is opt-in, in every release, beta included, and always off in CI unless\n" +
			"CAITLYN_TELEMETRY=1: nothing is sent unless you turn it on.\n\n" +
			"What decides it, first match wins: CAITLYN_TELEMETRY=0 or 1; DO_NOT_TRACK; telemetry in your user file\n" +
			"(caitlyn telemetry on or off); CI; otherwise off.\n\n" +
			"This command is only about usage data for Caitlyn. Your own traces, OpenTelemetry sent to your own collector,\n" +
			"are separate: OTEL_EXPORTER_OTLP_ENDPOINT turns them on, and neither turns the other on.\n\nMore: " + telemetry.DocsURL,
		Args: cobra.NoArgs,
	}
	cmd.AddCommand(onOff(f, true), onOff(f, false), status(f), reset(f), flush(f))
	root.AddCommand(cmd)
}

func onOff(f *cmdutil.Factory, on bool) *cobra.Command {
	use, short := "off", "Turn usage data for Caitlyn off and delete anything queued"
	if on {
		use, short = "on", "Turn usage data for Caitlyn on: send anonymous usage data from this machine"
	}
	return &cobra.Command{
		Use: use, Short: short, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			if err := cfg.Set("telemetry", fmt.Sprint(on), "", false); err != nil {
				return &cmdutil.Error{Exit: 1, Code: "CONFIG_WRITE_FAILED", Title: "The setting couldn't be saved.", Detail: err.Error(), Cause: err}
			}
			q := telemetry.QueueFor(f)
			if !on {
				if err := q.Delete(); err != nil {
					return &cmdutil.Error{Exit: 1, Code: "TELEMETRY_QUEUE", Title: "Usage data for Caitlyn is off, but its queue couldn't be deleted.", Detail: err.Error(), Cause: err}
				}
				f.Stderrf("Usage data for Caitlyn is off, and nothing queued is left to send. (Your own traces, if you export them, are unaffected.)\n")
			} else {
				f.Stderrf("Usage data for Caitlyn is on. See what it sends with: caitlyn telemetry status --pending\n")
			}
			// A variable outranks the file: say so, or the change looks ignored.
			d := telemetry.DecideFor(f)
			if d.Rule < 3 && d.On != on {
				f.Stderrf("%s still decides it for now.\n", d.Reason)
			}
			return nil
		},
	}
}

type statusView struct {
	On         bool              `json:"on"`
	Rule       int               `json:"rule"`
	Reason     string            `json:"reason"`
	Endpoint   bool              `json:"endpointConfigured"`
	InstallID  string            `json:"installId,omitempty"`
	Notice     bool              `json:"noticeShown"`
	Queued     int               `json:"queued"`
	Pending    []telemetry.Event `json:"pending,omitempty"`
	DocsURL    string            `json:"docs"`
	QueueFile  string            `json:"queueFile"`
	Collecting bool              `json:"collecting"`
}

func status(f *cmdutil.Factory) *cobra.Command {
	var pending bool
	c := &cobra.Command{
		Use: "status", Short: "Say whether usage data for Caitlyn is on, and why", Args: cobra.NoArgs,
		Long: "Says whether usage data for Caitlyn is on and which rule decided it. --pending prints exactly what is\nqueued, as it would be sent. Your own traces aren't covered here: they follow OTEL_EXPORTER_OTLP_ENDPOINT.",
		RunE: func(cmd *cobra.Command, args []string) error {
			d := telemetry.DecideFor(f)
			q := telemetry.QueueFor(f)
			st := q.LoadState()
			evs, _ := q.Pending()
			v := statusView{On: d.On, Rule: d.Rule, Reason: d.Reason, Endpoint: telemetry.EndpointFor(f) != "",
				InstallID: st.InstallID, Notice: !st.NoticeShown.IsZero(), Queued: len(evs), DocsURL: telemetry.DocsURL,
				QueueFile: q.Path(), Collecting: d.Collects()}
			format, err := output.Resolve(f)
			if err != nil {
				return err
			}
			if pending {
				if format == output.Table || format == output.Text {
					for _, e := range evs {
						b, _ := json.Marshal(e)
						fmt.Fprintf(f.IO.Out, "%s\n", b)
					}
					if len(evs) == 0 {
						f.Stderrf("Nothing is queued.\n")
					}
					return nil
				}
				v.Pending = evs
				if v.Pending == nil {
					v.Pending = []telemetry.Event{}
				}
			}
			if format == output.Table || format == output.Text {
				fmt.Fprintln(f.IO.Out, d.String())
				fmt.Fprintf(f.IO.Out, "Queued: %d events in %s\n", len(evs), q.Path())
				if st.InstallID != "" {
					fmt.Fprintf(f.IO.Out, "Install ID: %s (caitlyn telemetry reset makes a new one)\n", st.InstallID)
				}
				fmt.Fprintf(f.IO.Out, "This is usage data for Caitlyn only; your own traces follow OTEL_EXPORTER_OTLP_ENDPOINT.\n")
				fmt.Fprintf(f.IO.Out, "More: %s\n", telemetry.DocsURL)
				return nil
			}
			p, err := output.New(f, gen.UIFor(f))
			if err != nil {
				return err
			}
			return p.Value(v, "")
		},
	}
	c.Flags().BoolVar(&pending, "pending", false, "Print exactly what is queued, as it would be sent")
	return c
}

func reset(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use: "reset", Short: "Make a new anonymous install ID for usage data for Caitlyn, and delete anything queued", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := telemetry.QueueFor(f).Reset()
			if err != nil {
				return &cmdutil.Error{Exit: 1, Code: "TELEMETRY_QUEUE", Title: "The install ID couldn't be reset.", Detail: err.Error(), Cause: err}
			}
			f.Stderrf("New install ID: %s. Nothing queued under the old one is left.\n", id)
			return nil
		},
	}
}

func flush(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use: "flush", Short: "Send queued usage data for Caitlyn now (the CLI runs this in the background)", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			d := telemetry.DecideFor(f)
			q := telemetry.QueueFor(f)
			if !d.On {
				// Off: nothing may be sent, and nothing should be left.
				_ = q.Delete()
				return nil
			}
			if d.NoEndpoint {
				return nil
			}
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			// Failures are silent: the queue is kept for the next flush.
			_, _ = q.Flush(ctx, telemetry.EndpointFor(f), HTTPClient)
			return nil
		},
	}
}
