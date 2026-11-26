package hand

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/ci/cisession"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/configcmd"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// version reads an agent version (draft, live or a name) as the server sent it, with its ETag.
func readVersion(ctx context.Context, f *cmdutil.Factory, agentID, version string) (map[string]any, []byte, string, error) {
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return nil, nil, "", err
	}
	op := f.Manifest().Op("GetAgentVersion")
	in := invoke.NewInput()
	in.Set("agentId", agentID)
	in.Set("version", version)
	res, err := invoke.Call(ctx, cc, op, in)
	if err != nil {
		return nil, nil, "", err
	}
	v, err := output.Decode(res.Body)
	if err != nil {
		return nil, nil, "", err
	}
	obj, _ := v.(map[string]any)
	etag := res.Header.Get("ETag")
	if etag == "" {
		etag, _ = obj["etag"].(string)
	}
	return obj, res.Body, etag, nil
}

// readDraftFile reads a draft file (JSON or YAML, as `agents draft get -o yaml` writes it): the version with its
// configuration, or the configuration alone.
func readDraftFile(path string) (config map[string]any, etag string, err error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", cmdutil.Usagef("%s could not be read: %v", path, err)
	}
	j, err := output.YAMLToJSON(b)
	if err != nil {
		return nil, "", cmdutil.Usagef("%s is not valid JSON or YAML: %v", path, err)
	}
	v, err := output.Decode(j)
	if err != nil {
		return nil, "", err
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, "", cmdutil.Usagef("%s must hold an agent version or its configuration", path)
	}
	etag, _ = obj["etag"].(string)
	if c, ok := obj["configuration"].(map[string]any); ok {
		return c, etag, nil
	}
	return obj, etag, nil
}

// NewDraftDiff returns `agents draft diff` (7.1): a file against the current draft, member by member.
func NewDraftDiff(f *cmdutil.Factory) *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:   "diff <agent> [flags]",
		Short: "Compare a draft file with the agent's current draft",
		Long: `Compares a file (as agents draft get -o yaml writes it) with the agent's current draft, member by member: lists
are compared item by item. Nothing is changed. --fail-on changes exits 3 when they differ, for a CI check.

To compare two stored versions, use the server's own comparison: caitlyn agents versions compare AGENT@v11 --with v12.`,
		Example:     "  caitlyn agents draft diff GHT7YRWXPL -f agents/hr-assistant.yaml",
		Args:        cobra.ExactArgs(1),
		Annotations: map[string]string{"impact": "read", "scope": "agents:read", "operation": "GetAgentVersion"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if file == "" {
				return cmdutil.Usagef("Give the file: -f agents/hr-assistant.yaml")
			}
			run := cisession.For(f)
			if err := run.AcceptFailOn(ci.DiffConditions, ci.DiffDefaults); err != nil {
				return err
			}
			changes, etag, current, err := draftChanges(cmd.Context(), f, args[0], file)
			if err != nil {
				return err
			}
			u := gen.UIFor(f)
			p, err := output.New(f, u)
			if err != nil {
				return err
			}
			if p.Human {
				RenderDiff(f.IO.Out, u, changes, "")
				line := Summary(changes)
				if etag != "" {
					if etag == current {
						line += fmt.Sprintf("  The draft's ETag matches the file's (%s).", etag)
					} else {
						line += fmt.Sprintf("  The draft changed since the file was read: its ETag is %s, the file's %s.", current, etag)
					}
				}
				fmt.Fprintln(f.IO.Out, u.S(ui.Strong, line))
			} else if err := p.Value(map[string]any{"changes": changes, "etag": current}, ""); err != nil {
				return err
			}
			return failOnChanges(run, len(changes) > 0)
		},
	}
	cmd.Flags().StringVarP(&file, "file", "f", "", "The draft file")
	return cmd
}

// failOnChanges finishes a diff's run: --fail-on changes exits 3 when there are changes (15.6).
func failOnChanges(run *cisession.Run, changed bool) error {
	if changed {
		run.Hold("changes")
	}
	return run.Finish(0)
}

func draftChanges(ctx context.Context, f *cmdutil.Factory, agentID, file string) ([]Change, string, string, error) {
	want, etag, err := readDraftFile(file)
	if err != nil {
		return nil, "", "", err
	}
	draft, _, current, err := readVersion(ctx, f, agentID, "draft")
	if err != nil {
		return nil, "", "", err
	}
	have, _ := draft["configuration"].(map[string]any)
	if have == nil {
		have = map[string]any{}
	}
	return Diff(have, want), etag, current, nil
}

// NewDraftEdit returns `agents draft edit` (7.1): the draft in $EDITOR, the diff on save, a confirmation, then a
// replace with the ETag it read, so a draft someone else changed meanwhile is a 412, never overwritten.
func NewDraftEdit(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:         "edit <agent>",
		Short:       "Edit the agent's draft in your editor",
		Example:     "  caitlyn agents draft edit GHT7YRWXPL",
		Args:        cobra.ExactArgs(1),
		Annotations: map[string]string{"impact": "write", "scope": "agents:write", "operation": "ReplaceDraftVersion"},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !f.Interactive() {
				e := cmdutil.ActionNeeded("agents draft edit needs a terminal and an editor.", "")
				e.AddNext("caitlyn agents draft get "+args[0]+" -o yaml > draft.yaml", "export the draft")
				e.AddNext("caitlyn agents draft replace "+args[0]+" -f draft.yaml", "then replace it from the file")
				return e
			}
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			draft, raw, etag, err := readVersion(ctx, f, args[0], "draft")
			if err != nil {
				return err
			}
			dir, err := os.MkdirTemp("", "caitlyn-draft-")
			if err != nil {
				return err
			}
			defer os.RemoveAll(dir)
			path := filepath.Join(dir, args[0]+".yaml")
			b, err := output.JSONToYAML(raw)
			if err != nil {
				return err
			}
			header := "# The draft of " + args[0] + ". Change the configuration, save and close to apply.\n# Read-only members (createdAt, changedMembers…) are ignored.\n"
			if err := os.WriteFile(path, append([]byte(header), b...), 0o600); err != nil {
				return err
			}
			if err := configcmd.Edit(f, cfg, path); err != nil {
				return err
			}
			want, _, err := readDraftFile(path)
			if err != nil {
				return err
			}
			have, _ := draft["configuration"].(map[string]any)
			changes := Diff(have, want)
			u := gen.UIFor(f)
			if len(changes) == 0 {
				u.Infof("No changes.")
				return nil
			}
			RenderDiff(f.IO.ErrOut, u, changes, "")
			fmt.Fprintln(f.IO.ErrOut, u.E(ui.Strong, Summary(changes)))
			pr, err := prompt.For(f.IO)
			if err != nil {
				return err
			}
			ok, err := pr.Confirm("Replace the draft with this?", false)
			if err != nil || !ok {
				return cmdutil.Silent(exitcode.ActionNeeded)
			}
			res, err := replaceDraft(ctx, f, args[0], want, etag)
			if err != nil {
				return err
			}
			u.Successf("Replaced the draft of %s.  ETag %s.", args[0], res.Header.Get("ETag"))
			return nil
		},
	}
	return cmd
}

// replaceDraft sends a configuration as the agent's draft, If-Match the ETag that was read.
func replaceDraft(ctx context.Context, f *cmdutil.Factory, agentID string, config map[string]any, etag string) (*invoke.Result, error) {
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return nil, err
	}
	op := f.Manifest().Op("ReplaceDraftVersion")
	in := invoke.NewInput()
	in.Set("agentId", agentID)
	if err := checkMembers(f, "The draft for "+agentID, config); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(config))
	for k := range config {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, m := range op.Input {
			if m.Wire == k && m.Location == "body" {
				in.Set(m.Name, config[k])
			}
		}
	}
	// Never unconditionally: without the ETag that was read, someone else's change would be overwritten unseen
	if etag == "" {
		return nil, noETag(agentID, "the draft it read")
	}
	in.IfMatch = &etag
	return invoke.Call(ctx, cc, op, in)
}

// noETag: Caitlyn (or something between) sent no ETag, so a write can't be made conditional, and isn't made.
func noETag(agentID, what string) *cmdutil.Error {
	return &cmdutil.Error{Exit: exitcode.Conflict, Code: "PRECONDITION_UNAVAILABLE", Title: "Nothing was written: there was no ETag to check against.",
		Detail: fmt.Sprintf("The response for %s of agent %s carried no ETag, so the write couldn't be made conditional. A proxy may be removing the ETag header.", what, agentID)}
}
