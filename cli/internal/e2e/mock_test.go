// Package e2e runs the whole CLI, in process, against the repository's mock server (conformance/mock-server), as the
// SDKs' conformance suites do: no live Caitlyn is ever called.
package e2e

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
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
	port := 5300 + rand.IntN(400)
	cmd := exec.Command("node", filepath.Join(repoRoot, "conformance", "mock-server", "server.mjs"))
	cmd.Env = append(os.Environ(), fmt.Sprintf("PORT=%d", port))
	out, err := cmd.StdoutPipe()
	if err != nil {
		panic(err)
	}
	if err := cmd.Start(); err != nil {
		panic(err)
	}
	bufio.NewReader(out).ReadString('\n')
	base = fmt.Sprintf("http://127.0.0.1:%d", port)
	commands.Register()
	code := m.Run()
	cmd.Process.Kill()
	os.Exit(code)
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
	io, out, errOut := iostreams.Test(stdin)
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
