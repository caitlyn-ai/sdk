package hand

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/ci/cisession"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

type tailOptions struct {
	types, conversations, agents []string
	after, checkpoint, until     string
	timeout                      time.Duration
}

// NewEventsTail returns `caitlyn events tail` (6.4): the workspace's event stream with resume, checkpoints, and a
// match-then-exit mode for CI.
func NewEventsTail(f *cmdutil.Factory) *cobra.Command {
	o := &tailOptions{}
	cmd := &cobra.Command{
		Use:   "tail",
		Short: "Follow workspace events, with checkpoints and match-then-exit",
		Long: `Follows the workspace's events. The stream needs a filter, --type or a subject such as --conversation: there is
no stream of everything.

--checkpoint FILE reads the cursor to start after from the file, and writes each event's id back once the event has
been written to stdout, so a restart misses nothing (delivery is at least once: de-duplicate on id). When the server
can't carry on from a cursor, it sends stream.reset: the CLI prints it (it's data), warns, moves the checkpoint on,
and carries on; --fail-on reset exits 3 instead.

--until-match takes a jq expression and exits 0 at the first event it matches; --timeout bounds the wait. The CLI
prints "Listening." on stderr once the server is listening, so starting the action after it is race-free.`,
		Example: `  caitlyn events tail --type conversation.created -o jsonl
  caitlyn events tail --type message.completed --checkpoint ~/.caitlyn/events.cursor -o jsonl | vector --config events.toml
  caitlyn events tail --conversation 0193b1d4-5e2a-7c11-a9f0-2d6e8b4c7a10 --until-match '.type == "message.completed"' --timeout 5m`,
		Args:        cobra.NoArgs,
		Annotations: map[string]string{"impact": "read", "operation": "WatchWorkspaceEvents"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTail(cmd.Context(), f, o)
		},
	}
	fl := cmd.Flags()
	fl.StringArrayVar(&o.types, "type", nil, "Event types to receive (repeatable)")
	fl.StringArrayVar(&o.conversations, "conversation", nil, "Conversations to receive events about (repeatable)")
	fl.StringArrayVar(&o.agents, "agent", nil, "Agents to receive events about (repeatable), where the workspace's release supports it")
	fl.StringVar(&o.after, "after", "", "Start after this event id")
	fl.StringVar(&o.checkpoint, "checkpoint", "", "Read the start cursor from this file, and write each event's id back after it is printed")
	fl.StringVar(&o.until, "until-match", "", "Exit 0 at the first event this jq expression matches")
	fl.DurationVar(&o.timeout, "timeout", 0, "Stop after this long (exit 9), for example 10m")
	return cmd
}

func runTail(ctx context.Context, f *cmdutil.Factory, o *tailOptions) error {
	m := f.Manifest()
	op := m.Op("WatchWorkspaceEvents")
	if op == nil {
		return cmdutil.Usagef("This CLI's model has no workspace event stream.")
	}
	if len(o.types) == 0 && len(o.conversations) == 0 && len(o.agents) == 0 {
		e := cmdutil.Usagef("events tail needs a filter: --type, --conversation or --agent.")
		e.Detail = "There is no stream of every event in a workspace: name what you want to hear about."
		e.Hint = &cmdutil.Hint{Missing: []string{"--type"}}
		e.AddNext("caitlyn events tail --type conversation.created", "for example")
		return e
	}
	in := invoke.NewInput()
	setList := func(names []string, values []string) error {
		if len(values) == 0 {
			return nil
		}
		for _, n := range names {
			if op.Member(n) != nil {
				var l []any
				for _, v := range values {
					l = append(l, v)
				}
				in.Set(n, l)
				return nil
			}
		}
		return cmdutil.Usagef("This workspace's release can't filter events by %s yet.", strings.TrimSuffix(names[0], "s"))
	}
	if err := setList([]string{"types", "type"}, o.types); err != nil {
		return err
	}
	if err := setList([]string{"conversationIds", "conversationId"}, o.conversations); err != nil {
		return err
	}
	if err := setList([]string{"agentIds", "agentId"}, o.agents); err != nil {
		return err
	}
	after := o.after
	if o.checkpoint != "" && after == "" {
		if b, err := os.ReadFile(o.checkpoint); err == nil {
			after = strings.TrimSpace(string(b))
		} else if !errors.Is(err, os.ErrNotExist) {
			return cmdutil.Usagef("%s could not be read: %v", o.checkpoint, err)
		}
	}
	if after != "" {
		in.Set("after", after)
	}
	run := cisession.For(f)
	if err := run.AcceptFailOn(ci.EventsTailConditions, ci.EventsTailDefaults); err != nil {
		return err
	}
	failReset := false
	for _, c := range f.Globals.FailOn {
		failReset = failReset || c == "reset"
	}
	if o.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, o.timeout)
		defer cancel()
	}
	u := gen.UIFor(f)
	p, err := output.NewStream(f, u)
	if err != nil {
		return err
	}
	human := p.Format == output.Table && !p.Filtered()
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return err
	}
	s, err := invoke.Open(ctx, cc, m, op, in)
	if err != nil {
		return err
	}
	defer s.Close()
	// The server listens before it answers, so once Open has returned, an action can't be missed (6.4)
	if f.IO.IsStderrTTY() && human {
		fmt.Fprintln(f.IO.ErrOut, u.E(ui.Muted, "Listening "+u.G.Dot+" Ctrl-C to stop"))
	} else {
		fmt.Fprintln(f.IO.ErrOut, "Listening.")
	}
	for ev, err := range s.Events() {
		if err != nil {
			switch {
			case errors.Is(err, context.DeadlineExceeded) || (o.timeout > 0 && ctx.Err() == context.DeadlineExceeded):
				return &cmdutil.Error{Exit: exitcode.Timeout, Code: "TIMEOUT", Title: fmt.Sprintf("No matching event within %s.", o.timeout)}
			case ctx.Err() != nil:
				return cmdutil.Silent(exitcode.Interrupted)
			}
			return err
		}
		if human {
			gen.HumanEvent(f.IO.Out, u, ev)
		} else if err := p.Event(ev.Type, ev.ID, ev.Data); err != nil {
			return err
		}
		reset := ev.Type == "stream.reset"
		cursor := ev.ID
		if reset {
			var r struct {
				Cursor string `json:"cursor"`
			}
			if json.Unmarshal(ev.Data, &r) == nil && r.Cursor != "" {
				cursor = r.Cursor
			}
			u.Warnf("The stream was reset: some events were missed. Read the current state again.")
		}
		if o.checkpoint != "" && cursor != "" {
			if err := writeCheckpoint(o.checkpoint, cursor); err != nil {
				return err
			}
		}
		if reset {
			run.Hold("reset")
			if failReset {
				return run.Finish(0)
			}
		}
		if o.until != "" {
			line, _ := json.Marshal(map[string]any{"type": ev.Type, "id": ev.ID, "data": json.RawMessage(ev.Data)})
			v, err := output.Decode(line)
			if err != nil {
				continue
			}
			ok, err := output.MatchJQ(v, o.until)
			if err != nil {
				return err
			}
			if ok {
				return nil
			}
		}
	}
	return nil
}

// writeCheckpoint replaces the file atomically, after the event has been flushed to stdout.
func writeCheckpoint(path, cursor string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(cursor+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
