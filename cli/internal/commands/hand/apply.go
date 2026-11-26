package hand

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/ci/cisession"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// The directory format, until configuration bundles are modelled (7.2): caitlyn.yaml names the workspace and the
// agents, and agents/<id>.yaml holds each agent's version as `agents versions get -o yaml` writes it. Once
// ConfigurationBundle (:export, :inspect, :import) is in the model, export, diff and apply move to it with no change
// to how they're run.

// Manifest is caitlyn.yaml.
type Manifest struct {
	Workspace string   `yaml:"workspace,omitempty"`
	Agents    []string `yaml:"agents"`
}

func readManifest(dir string) (*Manifest, error) {
	b, err := os.ReadFile(filepath.Join(dir, "caitlyn.yaml"))
	if err != nil {
		return nil, cmdutil.Usagef("%s has no caitlyn.yaml: export one with caitlyn export --agent <agent> -o %s", dir, dir)
	}
	var m Manifest
	if err := yaml.Unmarshal(b, &m); err != nil {
		return nil, cmdutil.Usagef("caitlyn.yaml: %v", err)
	}
	return &m, nil
}

// NewExport returns `caitlyn export` (7.2).
func NewExport(f *cmdutil.Factory) *cobra.Command {
	var agents []string
	var dir, version string
	cmd := &cobra.Command{
		Use:   "export [flags]",
		Short: "Write agents' configuration to files, to keep as code",
		Long: `Writes each agent's version (live by default, or --version draft) to <dir>/agents/<agent>.yaml, and a caitlyn.yaml
that names the workspace and the agents. Edit the files, then compare with caitlyn diff and apply with caitlyn apply.`,
		Example:     "  caitlyn export --agent GHT7YRWXPL --agent AGYFAMYTND --dir caitlyn/",
		Args:        cobra.NoArgs,
		Annotations: map[string]string{"impact": "read", "scope": "agents:read", "operation": "GetAgentVersion"},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(agents) == 0 {
				return cmdutil.Usagef("Name the agents to export: --agent GHT7YRWXPL")
			}
			ws, err := f.Workspace()
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Join(dir, "agents"), 0o755); err != nil {
				return err
			}
			for _, a := range agents {
				_, raw, _, err := readVersion(ctx, f, a, version)
				if err != nil {
					return err
				}
				b, err := output.JSONToYAML(raw)
				if err != nil {
					return err
				}
				if err := os.WriteFile(filepath.Join(dir, "agents", a+".yaml"), b, 0o644); err != nil {
					return err
				}
			}
			b, _ := yaml.Marshal(&Manifest{Workspace: ws, Agents: agents})
			if err := os.WriteFile(filepath.Join(dir, "caitlyn.yaml"), b, 0o644); err != nil {
				return err
			}
			gen.UIFor(f).Successf("Exported %d agents (%s versions) to %s.", len(agents), version, dir)
			return nil
		},
	}
	cmd.Flags().StringArrayVar(&agents, "agent", nil, "An agent to export (repeatable)")
	cmd.Flags().StringVar(&dir, "dir", "caitlyn", "The folder to write")
	cmd.Flags().StringVar(&version, "version", "live", "Which version to export: live, draft or a version name")
	return cmd
}

type planEntry struct {
	Agent   string   `json:"agent"`
	Changes []Change `json:"changes"`
	ETag    string   `json:"etag"`
	// Publishable: apply --publish publishes this agent. Live isn't the file, and either the draft changes now, or
	// the draft (which matches the file) is work that was never published: no version live has ever pointed at has
	// this content (an earlier apply wrote it and its publish failed). When one has (PublishedAs), live was moved
	// away from it on purpose, a rollback, and is left alone.
	Publishable bool `json:"publishable"`
	// PublishedAs: the version, live before, whose content the file has, when live has moved away from it since: a
	// rollback, which --publish leaves alone unless --publish-over-rollback.
	PublishedAs string `json:"publishedAs,omitempty"`
	// RolledBack: live's newest change was a rollback ("v12 on 2026-11-05 by Ana Ngata"). While it is, --publish
	// never publishes the agent, whatever the file changes, unless --publish-over-rollback: someone moved live back
	// on purpose, and only a person who means it moves it forward again.
	RolledBack string `json:"rolledBack,omitempty"`
	// Unpublished: publishable with no change to the draft, which the plan shows on its own line.
	Unpublished bool `json:"unpublished,omitempty"`
	// Live is the version live points at, or "none".
	Live   string `json:"live"`
	config map[string]any
}

// plan compares each agent file with the agent's current draft.
func plan(ctx context.Context, f *cmdutil.Factory, dir string, override bool) ([]*planEntry, error) {
	m, err := readManifest(dir)
	if err != nil {
		return nil, err
	}
	ws, err := f.Workspace()
	if err != nil {
		return nil, err
	}
	// The manifest pins its workspace: applying it to another needs --workspace to name that one (7.2)
	if m.Workspace != "" && !strings.EqualFold(m.Workspace, ws) && !override {
		e := cmdutil.Usagef("%s/caitlyn.yaml is for %s, and you're using %s.", dir, m.Workspace, ws)
		e.Detail = "Name the workspace explicitly to use these files with another one."
		e.AddNext("caitlyn "+strings.Join(osArgs(), " ")+" --workspace "+ws, "if you mean it")
		return nil, e
	}
	var out []*planEntry
	for _, a := range m.Agents {
		// An agent ID names a file in agents/: never a path out of the folder
		if !agentIDPattern.MatchString(a) {
			return nil, cmdutil.Usagef("%s/caitlyn.yaml lists %q, which isn't an agent ID.", dir, a)
		}
		end := phase(f, "caitlyn_agent_"+a, "Agent "+a, true)
		want, _, err := readDraftFile(filepath.Join(dir, "agents", a+".yaml"))
		if err != nil {
			end(true)
			return nil, err
		}
		draft, _, etag, err := readVersion(ctx, f, a, "draft")
		if err != nil {
			end(true)
			return nil, err
		}
		if err := checkMembers(f, filepath.Join(dir, "agents", a+".yaml"), want); err != nil {
			end(true)
			return nil, err
		}
		have, _ := draft["configuration"].(map[string]any)
		e := &planEntry{Agent: a, Changes: Diff(have, want), ETag: etag, config: want, Live: "none", Publishable: true}
		if live, _, _, err := readVersion(ctx, f, a, "live"); err == nil {
			// read as live, the version's name is "live" and liveVersion is the version it points at
			if n, _ := live["liveVersion"].(string); n != "" {
				e.Live = n
			} else if n, _ := live["name"].(string); n != "" && n != "live" {
				e.Live = n
			}
			lc, _ := live["configuration"].(map[string]any)
			e.Publishable = len(Diff(lc, want)) > 0
			if e.Publishable {
				// Live's newest change is a rollback: held, whatever else the file changes
				rb, err := rolledBack(ctx, f, a)
				if err != nil {
					end(true)
					return nil, err
				}
				if rb != "" {
					e.Publishable, e.RolledBack = false, rb
				}
			}
			if e.Publishable {
				// Live isn't the file. If live has pointed at the file's content before, someone moved it away on
				// purpose (a rollback, a version published from the app), whether or not the draft still matches
				// the file (it may have been reset from live since): the draft is still written, but --publish
				// leaves live alone unless --publish-over-rollback. Only the history says which: the server records
				// no link from the draft to what it was published as.
				was, err := publishedWithContent(ctx, f, a, want)
				if err != nil {
					end(true)
					return nil, err
				}
				if was != "" {
					e.Publishable, e.PublishedAs = false, was
				}
			}
		} else if !isNotFound(err) {
			end(true)
			return nil, err
		}
		e.Unpublished = e.Publishable && len(e.Changes) == 0
		out = append(out, e)
		end(false)
	}
	return out, nil
}

var osArgs = func() []string { return os.Args[1:] }

func renderPlan(f *cmdutil.Factory, u *ui.UI, entries []*planEntry, ws string) int {
	w := f.IO.ErrOut
	if f.IO.IsStdoutTTY() {
		w = f.IO.Out
	}
	fmt.Fprintln(w, u.S(ui.Strong, "Plan for "+ws))
	fmt.Fprintln(w)
	total := 0
	for _, e := range entries {
		if e.Unpublished {
			total++
			fmt.Fprintf(w, "%s agent %s  %s\n", u.S(ui.Changed, "~"), e.Agent, unpublishedLine(e))
			if held(e) {
				fmt.Fprintf(w, "    %s\n", u.S(ui.Warning, rollbackLine(e)))
			}
			continue
		}
		if len(e.Changes) == 0 {
			fmt.Fprintf(w, "  %s\n", u.S(ui.Muted, "agent "+e.Agent+": "+unchangedLine(e)))
			continue
		}
		total += len(e.Changes)
		fmt.Fprintf(w, "%s agent %s  draft\n", u.S(ui.Changed, "~"), e.Agent)
		RenderDiff(w, u, e.Changes, "    ")
		if held(e) {
			fmt.Fprintf(w, "    %s\n", u.S(ui.Warning, rollbackLine(e)))
		}
	}
	fmt.Fprintln(w)
	if total == 0 {
		fmt.Fprintln(w, u.S(ui.Strong, "No changes."))
	} else {
		fmt.Fprintln(w, u.S(ui.Strong, fmt.Sprintf("%d %s. Drafts only; live changes only with --publish.", total, map[bool]string{true: "change", false: "changes"}[total == 1])))
	}
	return total
}

func planMarkdown(entries []*planEntry, ws string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "### Caitlyn plan for %s\n\n", ws)
	for _, e := range entries {
		if e.Unpublished {
			fmt.Fprintf(&b, "- agent `%s`: %s\n", e.Agent, unpublishedLine(e))
			if held(e) {
				fmt.Fprintf(&b, "  - %s\n", rollbackLine(e))
			}
			continue
		}
		if len(e.Changes) == 0 {
			fmt.Fprintf(&b, "- agent `%s`: %s\n", e.Agent, unchangedLine(e))
			continue
		}
		fmt.Fprintf(&b, "- agent `%s` (draft):\n", e.Agent)
		for _, c := range e.Changes {
			fmt.Fprintf(&b, "  - `%s %s`\n", c.Kind, c.Path)
		}
		if held(e) {
			fmt.Fprintf(&b, "  - %s\n", rollbackLine(e))
		}
	}
	return b.String()
}

// NewDiff returns `caitlyn diff` (7.2): the plan for a folder of files against the workspace.
func NewDiff(f *cmdutil.Factory) *cobra.Command {
	var dir string
	cmd := &cobra.Command{
		Use:         "diff [flags]",
		Short:       "Show what applying a folder of files would change",
		Example:     "  caitlyn diff -f caitlyn/ --fail-on changes --report markdown=plan.md",
		Args:        cobra.NoArgs,
		Annotations: map[string]string{"impact": "read", "scope": "agents:read", "operation": "GetAgentVersion,ListHistoryEntries"},
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			if dir, err = folder(cmd, cfg, dir); err != nil {
				return err
			}
			run := cisession.For(f)
			if err := run.AcceptFailOn(ci.DiffConditions, ci.DiffDefaults); err != nil {
				return err
			}
			entries, err := plan(cmd.Context(), f, dir, cmd.Flags().Changed("workspace") || f.Globals.Workspace != "")
			if err != nil {
				return err
			}
			ws, _ := f.Workspace()
			u := gen.UIFor(f)
			p, err := output.New(f, u)
			if err != nil {
				return err
			}
			total := 0
			for _, e := range entries {
				total += len(e.Changes)
				if e.Unpublished {
					total++ // counts as a change: --publish would change live
				}
				status := ci.Passed
				if (len(e.Changes) > 0 || e.Unpublished) && contains(f.Globals.FailOn, "changes") {
					status = ci.Failed
				}
				caseOf(f, "caitlyn diff", "agent "+e.Agent, status, Summary(e.Changes))
			}
			_ = run.Output("changes", fmt.Sprint(total > 0))
			run.Summary("Plan", planMarkdown(entries, ws))
			if p.Human {
				renderPlan(f, u, entries, ws)
			} else if err := p.Value(map[string]any{"workspace": ws, "agents": entries}, ""); err != nil {
				return err
			}
			return failOnChanges(run, total > 0)
		},
	}
	cmd.Flags().StringVarP(&dir, "file", "f", "caitlyn", "The folder exported with caitlyn export")
	return cmd
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// NewApply returns `caitlyn apply` (7.2): writes each agent's draft from its file, If-Match the draft it planned
// against. Live never changes; --publish --name publishes the drafts afterwards, as a separate step.
func NewApply(f *cmdutil.Factory) *cobra.Command {
	var dir, name, note string
	var publish, overRollback bool
	cmd := &cobra.Command{
		Use:   "apply [flags]",
		Short: "Write agents' drafts from a folder of files",
		Long: `Plans again (the workspace may have moved since you last looked), shows the plan, asks, then replaces each changed
agent's draft, sending the ETag of the draft it planned against, so a draft someone changed meanwhile is refused
(exit 7) rather than overwritten. Unchanged files change nothing, so running it again is safe. Live doesn't change:
publish with caitlyn agents versions publish, or --publish --name here.

--publish publishes every agent whose live version isn't its file, except where someone rolled live back: while
an agent's newest live change is a rollback, --publish leaves it alone whatever the file changes, and the same goes
for a file with the content of a version live has pointed at before and was moved away from since. This includes a
file reverted to an earlier configuration that was already published: it isn't published again on its own. --publish-over-rollback publishes those too, with --confirm naming them in CI and under an AI agent; or
publish one by hand with caitlyn agents versions publish.`,
		Example:     "  caitlyn apply -f caitlyn/ --yes\n  caitlyn apply -f caitlyn/ --yes --publish --name november-release --confirm GHT7YRWXPL",
		Args:        cobra.NoArgs,
		Annotations: map[string]string{"impact": "write", "scope": "agents:write", "operation": "GetAgentVersion,ReplaceDraftVersion,ListHistoryEntries"},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			if dir, err = folder(cmd, cfg, dir); err != nil {
				return err
			}
			// apply.publish is a person's own default (user file only); an AI agent and CI publish only with --publish
			if !cmd.Flags().Changed("publish") && cfg.Bool("apply.publish") && !f.Agent.On && !f.CI.In() {
				publish = true
			}
			if publish && name == "" {
				return cmdutil.Usagef("--publish needs --name for the new version")
			}
			if overRollback && !publish {
				return cmdutil.Usagef("--publish-over-rollback goes with --publish")
			}
			entries, err := plan(ctx, f, dir, f.Globals.Workspace != "")
			if err != nil {
				return err
			}
			if overRollback {
				// Publish over a rollback, on purpose: it is still user-facing, so --confirm names each one below
				for _, e := range entries {
					if held(e) {
						e.Publishable = true
						e.Unpublished = len(e.Changes) == 0
					}
				}
			}
			ws, _ := f.Workspace()
			u := gen.UIFor(f)
			renderPlan(f, u, entries, ws)
			var targets []string
			if publish {
				// Publishing changes what people get: the same checks as agents versions publish, with --confirm naming
				// every agent it publishes (18.5)
				for _, e := range entries {
					if e.Publishable {
						targets = append(targets, e.Agent)
					}
				}
				action := gen.Action{Name: "caitlyn apply --publish", Impact: "user-facing", Scopes: gen.ScopesOf(f.Manifest(), "PublishAgentVersion"), Targets: targets,
					Line: gen.CommandLine([]string{"caitlyn", "apply"}, args, cmd)}
				if err := gen.Allowed(f, action); err != nil {
					return err
				}
				if err := gen.Confirmed(f, action); err != nil {
					return err
				}
			}
			drafts := 0
			for _, e := range entries {
				drafts += len(e.Changes)
			}
			if drafts == 0 && len(targets) == 0 {
				_ = cisession.For(f).Output("changes", "false")
				return nil
			}
			if f.Globals.DryRun != "" {
				return nil
			}
			if !f.Globals.Yes {
				pr, err := prompt.For(f.IO)
				if err != nil {
					return cmdutil.ActionNeeded("Applying needs a confirmation, and there's no terminal to ask on.", "--yes")
				}
				ok, err := pr.Confirm("Apply to "+ws+"?", false)
				if err != nil || !ok {
					return cmdutil.Silent(exitcode.ActionNeeded)
				}
			}
			var updated []string
			etags := map[string]string{} // the draft's ETag: as planned, or after this apply wrote it
			for _, e := range entries {
				etags[e.Agent] = e.ETag
				if len(e.Changes) == 0 {
					continue
				}
				end := phase(f, "caitlyn_apply_"+e.Agent, "Applying "+e.Agent, false)
				res, err := replaceDraft(ctx, f, e.Agent, e.config, e.ETag)
				if err != nil {
					end(true)
					return err
				}
				end(false)
				updated = append(updated, e.Agent)
				etags[e.Agent] = res.Header.Get("ETag")
			}
			sort.Strings(updated)
			_ = cisession.For(f).Output("changes", fmt.Sprint(len(updated) > 0))
			_ = cisession.For(f).Output("drafts_updated", strings.Join(updated, ","))
			if len(updated) > 0 {
				u.Successf("Drafts updated: %s.", strings.Join(updated, ", "))
			}
			if !publish {
				if len(updated) > 0 {
					u.Nextf("Publish with: caitlyn agents versions publish %s@draft --name …", updated[0])
				}
				return nil
			}
			cc, _, err := f.Clients(ctx)
			if err != nil {
				return err
			}
			// Every agent whose live isn't its file: the drafts this apply wrote, and drafts an earlier apply wrote but
			// never published. PublishAgentVersion has no precondition on the draft (its If-Match is live's ETag), so
			// each draft is read again first and refused (exit 7) when it isn't the one planned or written: a draft
			// someone changed since is never published unseen. expectedLive guards live the same way.
			for _, e := range entries {
				if !e.Publishable {
					continue
				}
				a := e.Agent
				op := f.Manifest().Op("PublishAgentVersion")
				if _, _, et, err := readVersion(ctx, f, a, "draft"); err != nil {
					return err
				} else if want := etags[a]; want == "" || et == "" {
					return noETag(a, "the draft this apply wrote")
				} else if et != want {
					return &cmdutil.Error{Exit: exitcode.Conflict, Code: "PRECONDITION_FAILED", Title: "The draft changed after apply planned it",
						Detail: fmt.Sprintf("Someone changed the draft of %s since this apply planned or wrote it, so it wasn't published.", a),
						Hint:   &cmdutil.Hint{Next: []cmdutil.NextStep{{Run: "caitlyn diff -f " + dir, Why: "see what changed"}}}}
				}
				expected := e.Live
				in := invoke.NewInput()
				in.Set("agentId", a)
				in.Set("version", "draft")
				if op.Member("expectedLive") != nil {
					in.Set("expectedLive", expected)
				}
				if op.Member("name") != nil {
					in.Set("name", name)
				}
				if note != "" && op.Member("note") != nil {
					in.Set("note", note)
				}
				if _, err := invoke.Call(ctx, cc, op, in); err != nil {
					return err
				}
				u.Successf("Published the draft of %s as %s.", a, name)
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&dir, "file", "f", "caitlyn", "The folder exported with caitlyn export")
	cmd.Flags().BoolVar(&publish, "publish", false, "Publish the drafts afterwards (a separate step: live changes)")
	cmd.Flags().BoolVar(&overRollback, "publish-over-rollback", false, "With --publish, also publish an agent whose live version was moved away from the file's content (a rollback)")
	cmd.Flags().StringVar(&name, "name", "", "The new version's name, with --publish")
	cmd.Flags().StringVar(&note, "note", "", "The note written with the publish")
	return cmd
}

// folder is the folder diff and apply read: -f, else the project's apply.paths, else caitlyn/. One folder only,
// until several are supported.
func folder(cmd *cobra.Command, cfg *config.Config, dir string) (string, error) {
	if cmd.Flags().Changed("file") {
		return dir, nil
	}
	paths := cfg.Get("apply.paths").List
	switch len(paths) {
	case 0:
		return dir, nil
	case 1:
		return paths[0], nil
	}
	return "", cmdutil.Usagef("apply.paths names %d folders; diff and apply take one: set one, or give -f", len(paths))
}

// isNotFound: live isn't set yet before an agent's first publish.
func isNotFound(err error) bool { return cmdutil.FromError(err).Exit == exitcode.NotFound }

// agentIDPattern is an agent's ID: letters and digits (GHT7YRWXPL), never a path.
var agentIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// checkMembers refuses a file with a member, at any depth, ReplaceDraftVersion doesn't send: apply would show it in the
// plan, then drop it, and the plan would never settle (and, publishing, publish a new version every time).
func checkMembers(f *cmdutil.Factory, path string, config map[string]any) error {
	m := f.Manifest()
	op := m.Op("ReplaceDraftVersion")
	known := map[string]*spec.Member{}
	for _, mem := range op.Input {
		if mem.Location == "body" {
			known[mem.Wire] = mem
		}
	}
	var unknown []string
	for k, v := range config {
		mem := known[k]
		if mem == nil {
			unknown = append(unknown, k)
			continue
		}
		unknownMembers(m, mem.Type, v, k, &unknown, 0)
	}
	if len(unknown) == 0 {
		return nil
	}
	sort.Strings(unknown)
	return &cmdutil.Error{Exit: exitcode.Usage, Code: "CONFIG_INVALID", Title: fmt.Sprintf("%s has members this CLI doesn't know: %s.", path, strings.Join(unknown, ", ")),
		Detail: "Nothing was written. A misspelt member, or one your workspace added after this CLI's release: this CLI's model may be older than the workspace.",
		Hint:   &cmdutil.Hint{Next: []cmdutil.NextStep{{Run: "caitlyn update", Why: "if the workspace is newer than this CLI"}}}}
}

func unpublishedLine(e *planEntry) string {
	return fmt.Sprintf("draft unpublished: it matches the file, live (%s) doesn't; --publish publishes it", e.Live)
}

// unknownMembers adds the paths of members a value has that its modelled structure (or union) doesn't.
func unknownMembers(m *spec.Manifest, t *spec.Type, v any, path string, out *[]string, depth int) {
	if t == nil || v == nil || depth > 16 {
		return
	}
	switch t.Type {
	case "ref":
		sh := m.Shapes[t.Ref]
		obj, ok := v.(map[string]any)
		if sh == nil || !ok {
			return
		}
		byWire := map[string]*spec.Member{}
		for _, mem := range sh.Members {
			byWire[mem.Wire] = mem
		}
		for k, val := range obj {
			mem := byWire[k]
			if mem == nil {
				*out = append(*out, path+"."+k)
				continue
			}
			unknownMembers(m, mem.Type, val, path+"."+k, out, depth+1)
		}
	case "list":
		if l, ok := v.([]any); ok {
			for i, it := range l {
				unknownMembers(m, t.Member, it, fmt.Sprintf("%s[%d]", path, i), out, depth+1)
			}
		}
	case "map":
		if mp, ok := v.(map[string]any); ok {
			for k, it := range mp {
				unknownMembers(m, t.Value, it, path+"."+k, out, depth+1)
			}
		}
	}
}

// held: --publish leaves this agent's live version alone, because of a rollback (unless --publish-over-rollback).
func held(e *planEntry) bool { return e.PublishedAs != "" || e.RolledBack != "" }

// unchangedLine is an agent whose draft is its file: in step, or rolled back from the file's content on purpose.
func unchangedLine(e *planEntry) string {
	if held(e) {
		return "no changes; " + rollbackLine(e)
	}
	return "no changes"
}

// rollbackLine says why --publish leaves an agent's live version alone, or, with --publish-over-rollback, that it
// publishes over the rollback.
func rollbackLine(e *planEntry) string {
	if e.RolledBack != "" {
		if e.Publishable {
			return fmt.Sprintf("live was rolled back to %s: --publish-over-rollback publishes over the rollback", e.RolledBack)
		}
		return fmt.Sprintf("live was rolled back to %s, so --publish leaves it alone, whatever the file changes, until it is published on purpose (--publish-over-rollback)", e.RolledBack)
	}
	if e.Publishable {
		return fmt.Sprintf("the file is %s, published before, and live (%s) was moved from it since: --publish-over-rollback publishes it again", e.PublishedAs, e.Live)
	}
	return fmt.Sprintf("the file is %s, published before, and live (%s) was moved from it since, so --publish leaves live alone (--publish-over-rollback publishes it)", e.PublishedAs, e.Live)
}

// rolledBack describes live's newest change when it was a rollback ("v12 on 2026-11-05 by Ana Ngata"), or "".
func rolledBack(ctx context.Context, f *cmdutil.Factory, agentID string) (string, error) {
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return "", err
	}
	// The history is newest first: the first entry is live's latest change
	op := f.Manifest().Op("ListHistoryEntries")
	in := invoke.NewInput()
	in.Set("agentId", agentID)
	if op.Member("limit") != nil {
		in.Set("limit", 1)
	}
	res, err := invoke.Call(ctx, cc, op, in)
	if err != nil {
		return "", err
	}
	var page struct {
		Items []struct {
			Version   string `json:"version"`
			Kind      string `json:"kind"`
			ChangedAt string `json:"changedAt"`
			ChangedBy struct {
				DisplayName string `json:"displayName"`
			} `json:"changedBy"`
		} `json:"items"`
	}
	if err := json.Unmarshal(res.Body, &page); err != nil {
		return "", err
	}
	if len(page.Items) == 0 || page.Items[0].Kind != "rollback" {
		return "", nil
	}
	h := page.Items[0]
	out := h.Version
	if len(h.ChangedAt) >= 10 {
		out += " on " + h.ChangedAt[:10]
	}
	if h.ChangedBy.DisplayName != "" {
		out += " by " + h.ChangedBy.DisplayName
	}
	return out, nil
}

// publishedWithContent is a version live has pointed at whose configuration is config, or "": the history's versions,
// newest first, read until one matches.
func publishedWithContent(ctx context.Context, f *cmdutil.Factory, agentID string, config map[string]any) (string, error) {
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return "", err
	}
	op := f.Manifest().Op("ListHistoryEntries")
	seen := map[string]bool{}
	cursor := ""
	for {
		in := invoke.NewInput()
		in.Set("agentId", agentID)
		if cursor != "" {
			in.Set("cursor", cursor)
		}
		res, err := invoke.Call(ctx, cc, op, in)
		if err != nil {
			return "", err
		}
		var page struct {
			Items []struct {
				Version string `json:"version"`
			} `json:"items"`
			Next string `json:"nextCursor"`
		}
		if err := json.Unmarshal(res.Body, &page); err != nil {
			return "", err
		}
		for _, h := range page.Items {
			if h.Version == "" || seen[h.Version] {
				continue
			}
			seen[h.Version] = true
			v, _, _, err := readVersion(ctx, f, agentID, h.Version)
			if err != nil {
				if isNotFound(err) {
					continue
				}
				return "", err
			}
			vc, _ := v["configuration"].(map[string]any)
			if len(Diff(vc, config)) == 0 {
				return h.Version, nil
			}
		}
		if page.Next == "" {
			return "", nil
		}
		cursor = page.Next
	}
}
