// Package e2e runs the whole CLI, in process, against the repository's mock server (conformance/mock-server), as the
// SDKs' conformance suites do: no live Caitlyn is ever called.
package e2e

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

var (
	base     string
	repoRoot string
)

func TestMain(m *testing.M) {
	repoRoot, _ = filepath.Abs("../../..")
	if _, err := exec.LookPath("node"); err != nil {
		fmt.Fprintln(os.Stderr, "node not found: the CLI's end-to-end tests need Node to run the mock server")
		os.Exit(2)
	}
	b, stop, err := startMock()
	if err != nil {
		panic(err)
	}
	base = b
	commands.Register()
	code := m.Run()
	stop()
	os.Exit(code)
}

// startMock starts a mock server of its own on a free port and returns its address once it is listening, and how to
// stop it. TestMain starts the one most tests share; a test that runs in parallel starts its own, so no test resets
// another's.
func startMock() (string, func(), error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cmd := exec.Command("node", filepath.Join(repoRoot, "conformance", "mock-server", "server.mjs"))
	cmd.Env = append(os.Environ(), fmt.Sprintf("PORT=%d", port))
	out, err := cmd.StdoutPipe()
	if err != nil {
		return "", nil, err
	}
	if err := cmd.Start(); err != nil {
		return "", nil, err
	}
	if _, err := bufio.NewReader(out).ReadString('\n'); err != nil {
		cmd.Process.Kill()
		return "", nil, fmt.Errorf("the mock server didn't start: %w", err)
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port), func() { cmd.Process.Kill(); cmd.Wait() }, nil
}

// resetAt resets the mock server at b.
func resetAt(t *testing.T, b string) {
	t.Helper()
	resp, err := http.Post(b+"/__mock/reset", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func post(t *testing.T, path string, body any) {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(base+path, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func reset(t *testing.T) { post(t, "/__mock/reset", nil) }

func getJSON(t *testing.T, path string, into any) {
	t.Helper()
	resp, err := http.Get(base + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
		t.Fatal(err)
	}
}

// result is one CLI run.
type result struct {
	code        int
	out, errOut string
}

// run runs the CLI with args against the mock, signed in with the mock's personal access token, in a fresh home.
func run(t *testing.T, env map[string]string, stdin string, args ...string) result {
	t.Helper()
	return runOn(t, false, env, stdin, args...)
}

// runOn is run, with stdin, stdout and stderr terminals when tty is set: a person typing at a terminal.
func runOn(t *testing.T, tty bool, env map[string]string, stdin string, args ...string) result {
	t.Helper()
	io, out, errOut := iostreams.Test(stdin)
	io.SetTTY(tty, tty, tty)
	home := t.TempDir()
	vars := map[string]string{
		"HOME":                       home,
		"CAITLYN_CONFIG_DIR":         filepath.Join(home, ".caitlyn"),
		"CAITLYN_WORKSPACE":          "your-company.caitlyn.ai",
		"CAITLYN_ENDPOINT":           base,
		"CAITLYN_TOKEN":              "pat_test",
		"CAITLYN_TELEMETRY":          "0",
		"CAITLYN_NO_UPDATE_NOTIFIER": "1",
		"LANG":                       "en_NZ.UTF-8",
	}
	for k, v := range env {
		if v == "" {
			delete(vars, k)
			continue
		}
		vars[k] = v
	}
	for k, v := range vars {
		io.Setenv(k, v)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	code := root.Run(ctx, io, args, func(f *cmdutil.Factory) {
		f.Home = home
		f.WorkDir = home
	})
	return result{code: code, out: out.String(), errOut: errOut.String()}
}
