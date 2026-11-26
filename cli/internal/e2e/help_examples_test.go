package e2e

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// helpExamplesSkipped are the example lines that can't run unattended against the mock, and why. Each still has to
// name a real command and flags (describe's TestHelpExamplesAreRealCommands).
var helpExamplesSkipped = map[string]string{
	"auth login":        "opens a browser, or waits for a device code",
	"login":             "opens a browser, or waits for a device code",
	"update":            "reads the release channel from build.caitlyn.ai",
	"agents draft edit": "opens an editor",
	"config edit":       "opens an editor",
	"auth token":        "the example is a curl command",
	"auth switch":       "needs a second profile in the user file",
}

// Every example a group or hand-written command shows in its help runs against the mock, in a folder with the files
// the examples name, and is never a usage error (exit code 2): an example that names a flag the command lacks, or an
// argument it can't take, fails here. A destructive example may still stop for a confirmation (exit code 3).
func TestHelpExamplesRun(t *testing.T) {
	bin := buildCLI(t)
	io, _, _ := iostreams.Test("")
	u := ui.New(io)
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Version: "test"}
	tree, err := root.New(f, &u)
	if err != nil {
		t.Fatal(err)
	}
	type example struct{ command, line string }
	// (the order commands are walked in is the tree's, so the run is the same every time)
	var examples []example
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		if gen.Of(c) == nil {
			for _, line := range strings.Split(c.Example, "\n") {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasPrefix(line, "#") {
					examples = append(examples, example{strings.TrimPrefix(c.CommandPath(), "caitlyn "), line})
				}
			}
		}
		for _, s := range c.Commands() {
			walk(s)
		}
	}
	walk(tree)
	if len(examples) < 40 {
		t.Fatalf("only %d examples found", len(examples))
	}
	// A command's examples run in order in one folder, as a person would type them (agents draft diff's first line
	// writes the file its second reads)
	byCommand := map[string][]string{}
	var order []string
	for _, ex := range examples {
		if _, seen := byCommand[ex.command]; !seen {
			order = append(order, ex.command)
		}
		byCommand[ex.command] = append(byCommand[ex.command], ex.line)
	}
	// Each command's examples run as a parallel subtest, in their own folder against a mock server of their own from a
	// small pool, so one command's examples never see another's state
	var ran atomic.Int64
	pool := make(chan string, min(runtime.GOMAXPROCS(0), 4))
	for range cap(pool) {
		b, stop, err := startMock()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(stop)
		pool <- b
	}
	t.Run("commands", func(t *testing.T) {
		for _, command := range order {
			if why, ok := helpExamplesSkipped[command]; ok {
				t.Logf("skipped %s: %s", command, why)
				continue
			}
			t.Run(command, func(t *testing.T) {
				t.Parallel()
				b := <-pool
				defer func() { pool <- b }()
				resetAt(t, b)
				dir := t.TempDir()
				// The files the examples name: a handbook folder, a PDF, and an export of the agent
				os.MkdirAll(filepath.Join(dir, "handbook"), 0o755)
				os.WriteFile(filepath.Join(dir, "handbook", "leave.md"), []byte("# Leave\n"), 0o644)
				os.WriteFile(filepath.Join(dir, "leave-policy.pdf"), []byte("%PDF-1.4 leave"), 0o644)
				home := t.TempDir()
				env := []string{
					"PATH=" + bin + string(os.PathListSeparator) + os.Getenv("PATH"),
					"HOME=" + home, "CAITLYN_CONFIG_DIR=" + filepath.Join(home, ".caitlyn"),
					"CAITLYN_WORKSPACE=your-company.caitlyn.ai", "CAITLYN_ENDPOINT=" + b, "CAITLYN_TOKEN=pat_test",
					"CAITLYN_TELEMETRY=0", "CAITLYN_NO_UPDATE_NOTIFIER=1", "CAITLYN_PAGER=cat", "BROWSER=true",
				}
				setupCmd := exec.Command(filepath.Join(bin, "caitlyn"), "export", "--agent", agentID, "--dir", "caitlyn", "--version", "draft")
				setupCmd.Dir, setupCmd.Env = dir, env
				if out, err := setupCmd.CombinedOutput(); err != nil {
					t.Fatalf("export for the examples: %v\n%s", err, out)
				}
				for _, line := range byCommand[command] {
					if line == "caitlyn chat GHT7YRWXPL" {
						t.Logf("skipped %s: interactive, needs a terminal (examples/cli/ask-an-agent.sh runs it in one)", line)
						continue
					}
					// A follow (events tail) waits for events until it is stopped. What this checks, that the example is no usage
					// error, shows at once, so a follow is stopped after 2 seconds; anything else has 10.
					limit := 10 * time.Second
					if strings.Contains(line, "events tail") {
						limit = 2 * time.Second
					}
					ctx, cancel := context.WithTimeout(context.Background(), limit)
					cmd := exec.CommandContext(ctx, "sh", "-c", line)
					cmd.Dir, cmd.Env = dir, env
					var out bytes.Buffer
					cmd.Stdout, cmd.Stderr = &out, &out
					cmd.WaitDelay = time.Second
					code := 0
					started := time.Now()
					err := cmd.Run()
					if took := time.Since(started); took > 5*time.Second {
						t.Logf("%s took %s", line, took.Round(time.Second))
					}
					if err != nil {
						var ee *exec.ExitError
						if !errors.As(err, &ee) {
							t.Fatal(err)
						}
						code = ee.ExitCode()
					}
					cancel()
					ran.Add(1)
					if code == 2 || strings.Contains(out.String(), "unknown flag") || strings.Contains(out.String(), "unknown command") {
						t.Errorf("%s: example %q is a usage error (exit %d):\n%s", command, line, code, out.String())
					}
				}
			})
		}
	})
	t.Logf("ran %d of %d examples", ran.Load(), len(examples))
}
