// Package configcmd is `caitlyn config` (the CLI design, 13.6): read, set and inspect the layered configuration.
package configcmd

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/shellwords"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// New returns the config command.
func New(f *cmdutil.Factory, uiFor func() *ui.UI) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Read and change the CLI's configuration",
		Long: `The CLI's settings come from, highest first: flags, CAITLYN_* environment variables, the project file
(.caitlyn.toml, found by walking up to the repository root), your user file (~/.caitlyn/config: the profile, then
its top level), and built-in defaults. Credentials and anything that decides where they are sent never come from a
project file.`,
		Args: cobra.NoArgs,
	}
	var showOrigin, project bool
	get := &cobra.Command{
		Use:   "get <key>",
		Short: "Print a setting's effective value",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			if config.KeyNamed(args[0]) == nil && args[0] != "profile" {
				return unknownKey(args[0])
			}
			v := cfg.Get(args[0])
			// A variable named after a setting the environment never sets is ignored: say so, rather than leave someone
			// wondering why CAITLYN_INSECURE_STORAGE did nothing
			if k := config.KeyNamed(args[0]); k != nil && k.NoEnv {
				name := "CAITLYN_" + strings.ToUpper(strings.ReplaceAll(k.Name, ".", "_"))
				if f.IO.Getenv(name) != "" {
					fmt.Fprintf(f.IO.ErrOut, "Note: %s is ignored: %s comes only from a configuration file.\n", name, k.Name)
				}
			}
			if showOrigin {
				fmt.Fprintf(f.IO.Out, "%s\t%s\n", v.Value, origin(v))
				return nil
			}
			fmt.Fprintln(f.IO.Out, v.Value)
			return nil
		},
	}
	get.Flags().BoolVar(&showOrigin, "show-origin", false, "Also print where the value came from")

	set := &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Write a setting to your user file, a profile (--profile) or the project file (--project)",
		Example: `  caitlyn config set output json
  caitlyn config set agent_scopes read-only --profile default
  caitlyn config set knowledge_base KB4T7YQ2WL --project`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			key := args[0]
			if config.KeyNamed(key) == nil && key != "default_profile" {
				return unknownKey(key)
			}
			if err := personOnly(f, key); err != nil {
				return err
			}
			profile := ""
			if cmd.Flags().Changed("profile") || f.Globals.Profile != "" {
				profile = f.Globals.Profile
			} else if k := config.KeyNamed(key); k != nil && k.Profile && key != "workspace" {
				profile = cfg.Profile()
			}
			if project {
				profile = ""
			}
			if err := cfg.Set(key, args[1], profile, project); err != nil {
				return cmdutil.Usagef("%v", err)
			}
			where := cfg.UserPath
			switch {
			case project:
				where = cfg.ProjectPath
				if where == "" {
					where = ".caitlyn.toml"
				}
			case profile != "":
				where += " [profiles." + profile + "]"
			}
			uiFor().Successf("Set %s to %s in %s.", key, args[1], where)
			return nil
		},
	}
	set.Flags().BoolVar(&project, "project", false, "Write to the project file, .caitlyn.toml")

	unset := &cobra.Command{
		Use:   "unset <key>",
		Short: "Remove a setting from your user file, a profile (--profile) or the project file (--project)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			// The key is resolved as set resolves it: a setting's name, never a path into the file such as
			// profiles.default.read_only, which would get round the person-only check (profiles: --profile)
			key := args[0]
			if config.KeyNamed(key) == nil && key != "default_profile" {
				return unknownKey(key)
			}
			if err := personOnly(f, key); err != nil {
				return err
			}
			profile := ""
			if cmd.Flags().Changed("profile") || f.Globals.Profile != "" {
				profile = f.Globals.Profile
			} else if k := config.KeyNamed(key); k != nil && k.Profile && key != "workspace" {
				profile = cfg.Profile()
			}
			if project {
				profile = ""
			}
			if err := cfg.Unset(key, profile, project); err != nil {
				return cmdutil.Usagef("%v", err)
			}
			uiFor().Successf("Removed %s.", key)
			return nil
		},
	}
	unset.Flags().BoolVar(&project, "project", false, "Remove it from the project file")

	list := &cobra.Command{
		Use:   "list",
		Short: "Every effective setting",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			p, err := output.New(f, uiFor())
			if err != nil {
				return err
			}
			vals := cfg.All() // profile is one of the keys
			if (p.Format != output.Table && p.Format != output.Text) || p.Filtered() {
				out := []map[string]any{}
				for _, v := range vals {
					if v.Value == "" && !v.Set {
						continue
					}
					m := map[string]any{"key": v.Key, "value": v.Value, "origin": string(v.Origin)}
					if v.Source != "" {
						m["source"] = v.Source
					}
					out = append(out, m)
				}
				// through the printer, so -o yaml, --jq and --query work as on every other command
				return p.Value(out, "")
			}
			u := uiFor()
			headers := []string{"key", "value"}
			if showOrigin {
				headers = append(headers, "from")
			}
			var rows [][]ui.Cell
			for _, v := range vals {
				if v.Value == "" && !v.Set {
					continue
				}
				row := []ui.Cell{{Text: v.Key, Keep: true}, {Text: v.Value}}
				if showOrigin {
					row = append(row, ui.Cell{Text: origin(v), Role: ui.Muted})
				}
				rows = append(rows, row)
			}
			u.Table(f.IO.Out, f.IO.IsStdoutTTY(), headers, rows, "")
			return nil
		},
	}
	list.Flags().BoolVar(&showOrigin, "show-origin", false, "A column naming where each value came from")

	path := &cobra.Command{
		Use:   "path",
		Short: "The files read, in order, and whether each exists",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			for _, p := range []struct{ what, path string }{{"project", cfg.ProjectPath}, {"user", cfg.UserPath}} {
				state := "missing"
				if p.path == "" {
					state, p.path = "none found", "(.caitlyn.toml)"
				} else if _, err := os.Stat(p.path); err == nil {
					state = "exists"
				}
				fmt.Fprintf(f.IO.Out, "%s\t%s\t%s\n", p.what, p.path, state)
			}
			return nil
		},
	}

	edit := &cobra.Command{
		Use:   "edit",
		Short: "Open your user file (or --project) in the editor, and check it on save",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			if !f.Interactive() {
				return cmdutil.ActionNeeded("config edit needs a terminal; use caitlyn config set instead.", "")
			}
			target := cfg.UserPath
			if project {
				target = cfg.ProjectPath
				if target == "" {
					target = ".caitlyn.toml"
				}
			}
			before, _ := os.ReadFile(target)
			if err := Edit(f, cfg, target); err != nil {
				return err
			}
			if _, err := config.Load(config.Options{Getenv: f.IO.Getenv, Home: f.Home, WorkDir: f.WorkDir}); err != nil {
				_ = os.WriteFile(target, before, 0o600)
				return cmdutil.Usagef("The file wasn't kept, because it can't be used: %v", err)
			}
			uiFor().Successf("Saved %s.", target)
			return nil
		},
	}
	edit.Flags().BoolVar(&project, "project", false, "Edit the project file instead")

	profiles := &cobra.Command{
		Use:   "profiles",
		Short: "List the profiles in your user file",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			for _, p := range cfg.Profiles() {
				mark := " "
				if p == cfg.Profile() {
					mark = "*"
				}
				ws, _ := cfg.ProfileValue(p, "workspace")
				fmt.Fprintf(f.IO.Out, "%s %s\t%s\n", mark, p, ws.Value)
			}
			return nil
		},
	}
	cmd.AddCommand(get, set, unset, list, path, edit, profiles)
	return cmd
}

// personOnlyKeys decide what a credential may do, which credential is used and where it goes: an AI agent may not
// change them, as it may not change its own agent scopes (18.5).
var personOnlyKeys = map[string]bool{
	"agent_scopes": true, "read_only": true, "auth": true, "endpoint": true, "client_id": true, "scopes": true,
	"default_profile": true, "id_token_env": true, "id_token_source": true, "insecure_storage": true, "workspace": true,
}

func personOnly(f *cmdutil.Factory, key string) error {
	if f.Agent.On && personOnlyKeys[key] {
		return cmdutil.Forbiddenf("AGENT_NOT_ALLOWED", "Only a person can change %s: it decides what this profile's credential may do, or where it goes.", key)
	}
	return nil
}

func unknownKey(k string) error {
	e := cmdutil.Usagef("%s is not a setting.", k)
	var names []string
	for _, key := range config.Keys {
		names = append(names, key.Name)
	}
	e.Detail = "Settings: " + strings.Join(names, ", ") + "."
	return e
}

func origin(v config.Value) string {
	if v.Source == "" {
		return string(v.Origin)
	}
	return string(v.Origin) + "  " + v.Source
}

// Editor is the editor to run: config `editor` (CAITLYN_EDITOR, VISUAL, EDITOR), else vi (notepad on Windows).
func Editor(cfg *config.Config) string {
	if e := cfg.String("editor"); e != "" {
		return e
	}
	if os.PathSeparator == '\\' {
		return "notepad"
	}
	return "vi"
}

// Edit opens path in the editor and waits for it to close.
func Edit(f *cmdutil.Factory, cfg *config.Config, path string) error {
	parts := shellwords.Split(Editor(cfg))
	if len(parts) == 0 {
		parts = []string{"vi"}
	}
	c := exec.Command(parts[0], append(parts[1:], path)...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		return fmt.Errorf("the editor (%s) failed: %w", strings.Join(parts, " "), err)
	}
	return nil
}
