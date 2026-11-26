package aisetup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
)

// declinedFile, in the user folder, holds the projects whose person said "don't ask again": never in a repository.
const declinedFile = "ai-setup.json"

type declinedProjects struct {
	// Declined maps a project's folder to the day it was declined.
	Declined map[string]string `json:"declined"`
}

func readDeclined(dir string) declinedProjects {
	d := declinedProjects{Declined: map[string]string{}}
	if b, err := os.ReadFile(filepath.Join(dir, declinedFile)); err == nil {
		_ = json.Unmarshal(b, &d)
	}
	if d.Declined == nil {
		d.Declined = map[string]string{}
	}
	return d
}

// Declined reports whether the person said not to be asked again about the project.
func Declined(userDir, root string) bool {
	_, ok := readDeclined(userDir).Declined[root]
	return ok
}

// Decline remembers not to ask about the project again.
func Decline(userDir, root, day string) error {
	d := readDeclined(userDir)
	d.Declined[root] = day
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(userDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(userDir, declinedFile), append(b, '\n'), 0o600)
}

// Offer is what sign-in should do about setting up AI tools: Ask the question, show the Pointer line, or nothing.
type Offer struct {
	Ask, Pointer bool
	// Why is the reason for the choice, for tests and debugging.
	Why   string
	Root  string
	Tools []*Tool
}

// OfferFor decides the offer at the end of sign-in. It asks only when every condition holds: a person at a terminal
// (not CI, not an AI tool, not --no-input, stdout a terminal), inside a project (a repository or a .caitlyn.toml),
// with an AI tool found by its files there, nothing set up there yet, and no "don't ask again" for it. Otherwise it
// shows one pointer line, except where the CLI is quiet (the same places it never asks) or the project is already
// set up or was declined.
func OfferFor(f *cmdutil.Factory) Offer {
	switch {
	case f.CI.In():
		return Offer{Why: "CI"}
	case f.Agent.On:
		return Offer{Why: "agent mode"}
	case f.Globals.NoInput || f.IO.NeverPrompt:
		return Offer{Why: "no input"}
	case !f.IO.IsStdoutTTY():
		return Offer{Why: "stdout isn't a terminal"}
	}
	if _, err := prompt.For(f.IO); err != nil {
		return Offer{Why: "nobody to ask"}
	}
	cfg, err := f.Config()
	if err != nil {
		return Offer{Why: "configuration"}
	}
	home := f.Home
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	work := f.WorkDir
	if work == "" {
		work, _ = os.Getwd()
	}
	root, ok := ProjectRoot(work, home)
	if !ok {
		return Offer{Pointer: true, Why: "not in a project"}
	}
	o := Offer{Root: root}
	if Declined(cfg.Dir(), root) {
		o.Why = "declined"
		return o
	}
	if items, err := inventory(root); err != nil || hasSetup(items) {
		o.Why = "already set up"
		return o
	}
	for _, d := range Detect(root, Env{Home: home, Getenv: f.IO.Getenv}) {
		if len(d.Markers) > 0 {
			o.Tools = append(o.Tools, d.Tool)
		}
	}
	if len(o.Tools) == 0 {
		o.Pointer, o.Why = true, "no AI tool found in the project"
		return o
	}
	o.Ask, o.Why = true, "ask"
	return o
}

func hasSetup(items []item) bool {
	for _, it := range items {
		if it.what != WithDefaults {
			return true
		}
	}
	return false
}

// OfferAfterSignIn is the end of caitlyn auth login: one question, when OfferFor says to ask, whose yes runs
// caitlyn ai setup in place; else the pointer line, or nothing. A failure here never fails the sign-in, which has
// already succeeded: it is reported, with what to run.
func OfferAfterSignIn(f *cmdutil.Factory, cmd *cobra.Command, workspace, profile string, agentScopes []string) error {
	o := OfferFor(f)
	u := gen.UIFor(f)
	if o.Pointer {
		u.Infof("  Using an AI coding tool? Run caitlyn ai setup in your project.")
	}
	if !o.Ask {
		return nil
	}
	pr, err := prompt.For(f.IO)
	if err != nil {
		return nil
	}
	cfg, err := f.Config()
	if err != nil {
		return nil
	}
	them := "them"
	if len(o.Tools) == 1 {
		them = "it"
	}
	home := f.Home
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	fmt.Fprintf(f.IO.ErrOut, "\nThis project (%s) uses %s.\n", tilde(o.Root, home), labels(o.Tools))
	i, err := pr.Select(fmt.Sprintf("Set %s up to work with Caitlyn? You'll see every change before anything is written.", them), []prompt.Option{
		{Label: "Yes, show me what would change", Value: "yes"},
		{Label: "Not now", Value: "later"},
		{Label: "Don't ask again for this project", Value: "never"},
	}, 0)
	if err != nil {
		return nil
	}
	switch i {
	case 1:
		u.Infof("  Any time: caitlyn ai setup")
		return nil
	case 2:
		if err := Decline(cfg.Dir(), o.Root, f.Now().Format("2006-01-02")); err != nil {
			u.Warnf("Couldn't remember that: %v", err)
			return nil
		}
		u.Infof("  You won't be asked again here. Any time: caitlyn ai setup")
		return nil
	}
	fmt.Fprintln(f.IO.Out)
	err = runSetup(cmd, f, &setupOptions{dir: o.Root}, &signIn{workspace: workspace, profile: profile, agentScopes: agentScopes, pr: pr})
	var ce *cmdutil.Error
	if err != nil && !(errors.As(err, &ce) && ce.Silent) {
		e := cmdutil.FromError(err)
		u.Warnf("Signed in, but the AI tools weren't set up: %s", e.Title)
		u.Nextf("Try again: caitlyn ai setup")
	}
	return nil
}
