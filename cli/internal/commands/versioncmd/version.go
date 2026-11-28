// Package versioncmd is `caitlyn version [--json]` (the CLI design, 8.1): the CLI's, the Go SDK's and the model's
// versions, the Go toolchain, the platform, and what CI and agent detection decided. The updater runs the new
// binary's `version --json` to check it starts.
package versioncmd

import (
	"encoding/json"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/emblem"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/skew"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/update"
	caitlyn "github.com/caitlyn-ai/sdk/go"
	"github.com/caitlyn-ai/sdk/go/core"
)

// Info is what `version --json` prints.
type Info struct {
	Version string `json:"version"`
	// Stability is the CLI's maturity as a whole: preview, or stable (cmdutil.Stability).
	Stability    string    `json:"stability"`
	SDKVersion   string    `json:"sdkVersion"`
	ModelVersion string    `json:"modelVersion"`
	Go           string    `json:"go"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	CI           CIInfo    `json:"ci"`
	Agent        AgentInfo `json:"agent"`
	// Workspace is the profile's workspace and its release as last seen (8.1, 8.2), when known.
	Workspace *WorkspaceInfo `json:"workspace,omitempty"`
	// SigningKeys are the release keys built in: minisign for update manifests, cosign for checksums and the image.
	// Placeholders in a build that isn't a release.
	SigningKeys SigningKeys `json:"signingKeys"`
}

// SigningKeys are the public keys this binary trusts and its releases are signed with (8.4).
type SigningKeys struct {
	Minisign string `json:"minisign"`
	Cosign   string `json:"cosign"`
}

// WorkspaceInfo is the workspace's release as the last command saw it, and the commands it can't serve yet.
type WorkspaceInfo struct {
	Host       string    `json:"host"`
	Profile    string    `json:"profile"`
	Version    string    `json:"version,omitempty"`
	SeenAt     time.Time `json:"seenAt,omitzero"`
	NeedsNewer []Needs   `json:"needsNewer,omitempty"`
}

// Needs is a command the workspace's release is too old for.
type Needs struct {
	Command string `json:"command"`
	Since   string `json:"since"`
}

// workspace reads the cached release: version never calls Caitlyn (the updater runs it to check a new binary starts).
func workspace(f *cmdutil.Factory) *WorkspaceInfo {
	cfg, err := f.Config()
	if err != nil || cfg == nil || cfg.String("workspace") == "" {
		return nil
	}
	w := &WorkspaceInfo{Host: cfg.String("workspace"), Profile: cfg.Profile()}
	seen := skew.Load(cfg.Dir(), cfg.Profile())
	if seen == nil {
		return w
	}
	w.Version, w.SeenAt = seen.Version, seen.At
	m, err := spec.Load()
	if err != nil {
		return w
	}
	for _, c := range m.Commands {
		if op := m.Op(c.Operation); op != nil && !c.Hidden && op.Since != "" && skew.Compare(op.Since, seen.Version) > 0 {
			w.NeedsNewer = append(w.NeedsNewer, Needs{Command: c.Name(), Since: op.Since})
		}
	}
	sort.Slice(w.NeedsNewer, func(i, j int) bool { return w.NeedsNewer[i].Command < w.NeedsNewer[j].Command })
	return w
}

// CIInfo is what CI detection decided (15.1).
type CIInfo struct {
	Detected    bool   `json:"detected"`
	Provider    string `json:"provider,omitempty"`
	PullRequest bool   `json:"pullRequest,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

// AgentInfo is what agent detection decided (18.1).
type AgentInfo struct {
	Detected bool   `json:"detected"`
	Name     string `json:"name,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// Collect gathers the run's version information.
func Collect(f *cmdutil.Factory) Info {
	return Info{
		Version: f.Version, Stability: cmdutil.Stability, SDKVersion: core.ModuleVersion(caitlyn.ModulePath, caitlyn.SDKVersion), ModelVersion: caitlyn.ModelVersion,
		Go: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH,
		CI:          CIInfo{Detected: f.CI.In(), Provider: f.CI.Name, PullRequest: f.CI.PullRequest, Reason: f.CI.Reason},
		Agent:       AgentInfo{Detected: f.Agent.On, Name: f.Agent.Name, Reason: f.Agent.Reason},
		Workspace:   workspace(f),
		SigningKeys: SigningKeys{Minisign: update.PublicKey, Cosign: update.CosignPublicKey},
	}
}

// workspaceLines are the plain-text lines about the workspace's release (8.1).
func (i Info) workspaceLines() []string {
	w := i.Workspace
	if w == nil {
		return nil
	}
	if w.Version == "" {
		return []string{fmt.Sprintf("Workspace %s: its release isn't known yet; it is learnt from the next command you run.", w.Host)}
	}
	lines := []string{fmt.Sprintf("Workspace %s runs Caitlyn %s.", w.Host, w.Version)}
	if n := len(w.NeedsNewer); n > 0 {
		var parts []string
		for _, c := range w.NeedsNewer {
			parts = append(parts, fmt.Sprintf("%s (%s)", c.Command, c.Since))
		}
		noun := "commands need"
		if n == 1 {
			noun = "command needs"
		}
		lines = append(lines, fmt.Sprintf("  %d %s a newer release: %s.", n, noun, strings.Join(parts, ", ")))
	}
	return lines
}

// Line is the one-line form: caitlyn 0.12.0 (Go SDK 0.12.0, model 5.144.0, go1.25.3 darwin/arm64).
func (i Info) Line() string {
	return fmt.Sprintf("caitlyn %s (Go SDK %s, model %s, %s %s/%s)", i.Version, i.SDKVersion, i.ModelVersion, i.Go, i.OS, i.Arch)
}

// Add adds `caitlyn version`. It is one of root.AddCommands.
func Add(root *cobra.Command, f *cmdutil.Factory) {
	var asJSON, logo bool
	cmd := &cobra.Command{
		Use:   "version",
		Short: "Print the CLI's version, and what it detected about where it runs",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			info := Collect(f)
			// --jq and --query filter the JSON, as on every other command (caitlyn version --json --jq .signingKeys)
			if f.Globals.JQ != "" || f.Globals.Query != "" {
				if p, err := output.New(f, nil); err == nil {
					return p.Value(info, "")
				}
			}
			format := output.JSON
			if !asJSON {
				// A broken configuration must not stop version: it is how the updater checks a new binary starts.
				if v, err := output.Resolve(f); err == nil {
					format = v
				} else {
					format = output.Table
				}
			}
			if format == output.JSON || format == output.JSONL || format == output.YAML {
				if format == output.YAML {
					if p, err := output.New(f, nil); err == nil {
						return p.Value(info, "")
					}
				}
				b, err := json.MarshalIndent(info, "", "  ")
				if format == output.JSONL {
					b, err = json.Marshal(info)
				}
				if err != nil {
					return err
				}
				_, err = fmt.Fprintf(f.IO.Out, "%s\n", b)
				return err
			}
			if logo {
				detail, lines := "", info.workspaceLines()
				if note := cmdutil.StabilityNote(); note != "" {
					lines = append([]string{note}, lines...)
				}
				if len(lines) > 0 {
					detail, lines = lines[0], lines[1:]
				}
				emblem.Version(f, gen.UIFor(f), f.IO.Out, "caitlyn "+info.Version, "", detail, lines...)
			} else {
				fmt.Fprintln(f.IO.Out, info.Line())
				if note := cmdutil.StabilityNote(); note != "" {
					fmt.Fprintln(f.IO.Out, note)
				}
				for _, l := range info.workspaceLines() {
					fmt.Fprintln(f.IO.Out, l)
				}
			}
			if info.CI.Detected {
				pr := ""
				if info.CI.PullRequest {
					pr = ", in a merge or pull request"
				}
				fmt.Fprintf(f.IO.Out, "CI: %s (from %s%s)\n", info.CI.Provider, info.CI.Reason, pr)
			}
			if info.Agent.Detected {
				name := info.Agent.Name
				if name == "" {
					name = "an AI agent"
				}
				fmt.Fprintf(f.IO.Out, "AI agent: %s (from %s)\n", name, info.Agent.Reason)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Print it as JSON")
	cmd.Flags().BoolVar(&logo, "logo", false, "With the Caitlyn emblem, where the terminal can show it")
	root.AddCommand(cmd)
}
