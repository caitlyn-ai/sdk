package describe

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
)

// StartBrowser starts a program that opens url and does not wait for it. Tests replace it.
var StartBrowser = func(name string, args ...string) error {
	return exec.Command(name, args...).Start()
}

// BrowserCommand is the program that opens a URL here: the browser setting (CAITLYN_BROWSER, then BROWSER) when
// set, else the platform's opener. ok is false where there is no browser to open (a Linux machine with no display).
func BrowserCommand(f *cmdutil.Factory, url string) (name string, args []string, ok bool) {
	if cfg, err := f.Config(); err == nil && cfg != nil {
		if b := strings.TrimSpace(cfg.String("browser")); b != "" {
			parts := strings.Fields(b)
			return parts[0], append(parts[1:], url), true
		}
	}
	switch runtime.GOOS {
	case "darwin":
		return "open", []string{url}, true
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", url}, true
	}
	if f.IO.Getenv("DISPLAY") == "" && f.IO.Getenv("WAYLAND_DISPLAY") == "" {
		return "", nil, false
	}
	return "xdg-open", []string{url}, true
}

// DocsTarget is the page for the command named by words: a group's own page, a command's section on its group's
// page, or the CLI section's start page for no words.
func DocsTarget(root *cobra.Command, words []string) (string, error) {
	if len(words) == 0 {
		return gen.DocsURL(nil), nil
	}
	target, rest, err := root.Find(words)
	if err != nil || len(rest) > 0 || target == root {
		e := cmdutil.Usagef("caitlyn %s is not a command.", strings.Join(words, " "))
		e.AddNext("caitlyn commands", "list every command")
		e.AddNext("caitlyn docs", "open the CLI's docs")
		return "", e
	}
	path := PathOf(target)
	if IsGroup(target) {
		return gen.GroupDocsURL(path), nil
	}
	return gen.DocsURL(path), nil
}

func newDocsCmd(f *cmdutil.Factory) *cobra.Command {
	var printOnly bool
	c := &cobra.Command{
		Use:   "docs [command]...",
		Short: "Open a command's page in the docs",
		Long: `Opens a command's page on build.caitlyn.ai in your browser: caitlyn docs kb sync.

With no command, it opens the CLI's docs. Where there is no browser to open (no terminal, an AI agent, CI, or a
machine with no display), or with --print, it prints the page's address instead.`,
		Args: cobra.ArbitraryArgs,
		ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
			target, _, _ := cmd.Root().Find(args)
			var out []string
			for _, s := range target.Commands() {
				if Keep(s) && !s.Hidden && strings.HasPrefix(s.Name(), toComplete) {
					out = append(out, s.Name())
				}
			}
			return out, cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			url, err := DocsTarget(cmd.Root(), args)
			if err != nil {
				return err
			}
			if printOnly || !f.IO.IsStdoutTTY() || f.Agent.On || f.CI.In() {
				fmt.Fprintln(f.IO.Out, url)
				return nil
			}
			name, bargs, ok := BrowserCommand(f, url)
			if !ok {
				fmt.Fprintln(f.IO.Out, url)
				return nil
			}
			if err := StartBrowser(name, bargs...); err != nil {
				// No browser after all: the address is what the person needs
				fmt.Fprintln(f.IO.Out, url)
				return nil
			}
			fmt.Fprintf(f.IO.ErrOut, "Opening %s in your browser.\n", url)
			return nil
		},
	}
	c.Flags().BoolVar(&printOnly, "print", false, "Print the page's address instead of opening it")
	return annotate(c, "read", "")
}
