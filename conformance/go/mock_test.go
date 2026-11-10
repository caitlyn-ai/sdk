package conformance

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// mock drives conformance/mock-server/server.mjs, started once for the test binary.
type mock struct{ base string }

var (
	server mock
	// root is the repository root.
	root string
)

func TestMain(m *testing.M) {
	root, _ = filepath.Abs("../..")
	port := 4900 + rand.IntN(300)
	cmd := exec.Command("node", filepath.Join(root, "conformance", "mock-server", "server.mjs"))
	cmd.Env = append(os.Environ(), fmt.Sprintf("PORT=%d", port))
	out, err := cmd.StdoutPipe()
	if err != nil {
		panic(err)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "node not found: the suite needs Node to run the mock server:", err)
		os.Exit(2)
	}
	bufio.NewReader(out).ReadString('\n')
	server = mock{base: fmt.Sprintf("http://127.0.0.1:%d", port)}
	code := m.Run()
	cmd.Process.Kill()
	os.Exit(code)
}

func (m mock) post(t *testing.T, path string, body any) {
	t.Helper()
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	resp, err := http.Post(m.base+path, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

// fresh resets the mock and returns it.
func fresh(t *testing.T) mock {
	t.Helper()
	server.post(t, "/__mock/reset", nil)
	return server
}

func (m mock) faults(t *testing.T, f map[string]any) { m.post(t, "/__mock/faults", f) }

type logged struct {
	Event       string            `json:"event"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Query       string            `json:"query"`
	Headers     map[string]string `json:"headers"`
	HeaderNames []string          `json:"headerNames"`
	Body        string            `json:"body"`
	RequestID   string            `json:"requestId"`
}

func (m mock) requests(t *testing.T) []logged {
	t.Helper()
	resp, err := http.Get(m.base + "/__mock/requests")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []logged
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func (m mock) matching(t *testing.T, pred func(logged) bool) []logged {
	var out []logged
	for _, r := range m.requests(t) {
		if pred(r) {
			out = append(out, r)
		}
	}
	return out
}

func pathHasSuffix(s string) func(logged) bool {
	return func(r logged) bool { return r.Path != "" && strings.HasSuffix(r.Path, s) }
}

func pathContains(s string) func(logged) bool {
	return func(r logged) bool { return strings.Contains(r.Path, s) }
}

// api returns the logged requests to the API itself (not the upload target).
func (m mock) api(t *testing.T) []logged {
	return m.matching(t, func(r logged) bool { return strings.HasPrefix(r.Path, "/v3/") })
}

// primeExample makes the mock answer the next request with an example case.
func (m mock) primeExample(t *testing.T, id string) {
	m.post(t, "/__mock/example", map[string]string{"id": id})
}

type exampleResult struct {
	ID         string   `json:"id"`
	Served     bool     `json:"served"`
	Mismatches []string `json:"mismatches"`
}

func (m mock) exampleResult(t *testing.T) exampleResult {
	t.Helper()
	resp, err := http.Get(m.base + "/__mock/example")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out exampleResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}
