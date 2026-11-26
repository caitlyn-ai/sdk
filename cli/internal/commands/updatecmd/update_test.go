package updatecmd_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"aead.dev/minisign"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/updatecmd"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/update"
)

var registerOnce sync.Once

// server publishes releases signed with a key made for the test.
type server struct {
	srv      *httptest.Server
	pub      string
	priv     minisign.PrivateKey
	files    map[string][]byte
	pointers atomic.Int32
}

func newServer(t *testing.T) *server {
	pub, priv, _ := minisign.GenerateKey(rand.Reader)
	pk, _ := pub.MarshalText()
	s := &server{pub: string(pk), priv: priv, files: map[string][]byte{}}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/channels/") {
			s.pointers.Add(1)
		}
		b, ok := s.files[strings.TrimPrefix(r.URL.Path, "/cli/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(b)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *server) publish(version, channel string) {
	body := []byte("#!caitlyn " + version + "\n")
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "caitlyn", Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(body)
	tw.Close()
	gz.Close()
	h := sha256.Sum256(b.Bytes())
	dir := version + "/"
	m := update.Manifest{Version: version, Channel: channel, Platforms: []update.Platform{{OS: "linux", Arch: "amd64", URL: "caitlyn.tar.gz", Size: int64(b.Len()), SHA256: hex.EncodeToString(h[:])}}}
	mb, _ := json.Marshal(m)
	s.files[dir+"manifest.json"] = mb
	s.files[dir+"manifest.json.minisig"] = minisign.Sign(s.priv, mb)
	s.files[dir+"caitlyn.tar.gz"] = b.Bytes()
	if channel != "" {
		p, _ := json.Marshal(update.ChannelPointer{Version: version})
		s.files["channels/"+channel+".json"] = p
	}
}

type env struct {
	t   *testing.T
	s   *server
	exe string
}

func setup(t *testing.T) *env {
	registerOnce.Do(commands.Register)
	s := newServer(t)
	e := &env{t: t, s: s, exe: filepath.Join(t.TempDir(), "caitlyn")}
	_ = os.WriteFile(e.exe, []byte("#!caitlyn 0.12.0\n"), 0o755)
	prev := updatecmd.NewUpdater
	t.Cleanup(func() { updatecmd.NewUpdater = prev })
	updatecmd.NewUpdater = func(f *cmdutil.Factory) (*update.Updater, error) {
		return &update.Updater{BaseURL: s.srv.URL + "/cli/", PublicKey: s.pub, Exe: e.exe, GOOS: "linux", GOARCH: "amd64",
			StartCheck: func(_ context.Context, p string) (string, error) {
				b, err := os.ReadFile(p)
				return strings.TrimPrefix(strings.TrimSpace(string(b)), "#!caitlyn "), err
			}}, nil
	}
	return e
}

type result struct {
	code           int
	stdout, stderr string
}

func (e *env) run(home string, vars map[string]string, tty bool, args ...string) result {
	io, out, errOut := iostreams.Test("")
	if tty {
		io.SetTTY(true, true, true)
	}
	io.Environ = []string{"CAITLYN_CONFIG_DIR=" + filepath.Join(home, ".caitlyn"), "CAITLYN_TELEMETRY=0"}
	for k, v := range vars {
		io.Setenv(k, v)
	}
	code := root.Run(context.Background(), io, args, func(f *cmdutil.Factory) {
		f.Home, f.WorkDir, f.Version = home, home, "0.12.0"
	})
	return result{code, out.String(), errOut.String()}
}

func (e *env) binary() string {
	b, _ := os.ReadFile(e.exe)
	return strings.TrimPrefix(strings.TrimSpace(string(b)), "#!caitlyn ")
}

func TestUpdateCheckAndApply(t *testing.T) {
	e := setup(t)
	e.s.publish("0.13.0", "stable")
	home := t.TempDir()
	r := e.run(home, nil, false, "update", "--check", "-o", "json")
	var v map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &v); err != nil || v["available"] != true || v["latest"] != "0.13.0" || v["current"] != "0.12.0" {
		t.Fatalf("--check: %v %q %q", err, r.stdout, r.stderr)
	}
	if e.binary() != "0.12.0" {
		t.Fatal("--check changes nothing")
	}
	r = e.run(home, nil, false, "update")
	if r.code != 3 || !strings.Contains(r.stderr, "--yes") || e.binary() != "0.12.0" {
		t.Fatalf("without a terminal, it needs --yes: %d %s", r.code, r.stderr)
	}
	r = e.run(home, nil, false, "update", "--yes")
	if r.code != 0 || e.binary() != "0.13.0" {
		t.Fatalf("update --yes: %d %s", r.code, r.stderr)
	}
	r = e.run(home, nil, false, "update", "--rollback", "--yes")
	if r.code != 0 || e.binary() != "0.12.0" {
		t.Fatalf("--rollback: %d %s", r.code, r.stderr)
	}
}

func TestNeverDowngradesUnlessAsked(t *testing.T) {
	e := setup(t)
	e.s.publish("0.11.0", "stable")
	home := t.TempDir()
	r := e.run(home, nil, false, "update", "--yes")
	if r.code != 0 || e.binary() != "0.12.0" || !strings.Contains(r.stderr, "up to date") {
		t.Fatalf("an older channel release is never installed: %d %s", r.code, r.stderr)
	}
	r = e.run(home, nil, false, "update", "--version", "0.11.0", "--yes")
	if r.code != 0 || e.binary() != "0.11.0" {
		t.Fatalf("--version may downgrade: %d %s", r.code, r.stderr)
	}
}

func TestBetaChannelIsRemembered(t *testing.T) {
	e := setup(t)
	e.s.publish("0.13.0-beta.2", "beta")
	home := t.TempDir()
	if r := e.run(home, nil, false, "update", "--channel", "beta", "--yes"); r.code != 0 || e.binary() != "0.13.0-beta.2" {
		t.Fatalf("%d %s", r.code, r.stderr)
	}
	cfg, _ := os.ReadFile(filepath.Join(home, ".caitlyn", "config"))
	if !strings.Contains(string(cfg), `update_channel = "beta"`) && !strings.Contains(string(cfg), "update_channel = 'beta'") {
		t.Fatalf("the channel is saved: %q", cfg)
	}
	if r := e.run(home, nil, false, "update", "--channel", "nightly"); r.code != 2 {
		t.Fatalf("an unknown channel is a usage error: %d", r.code)
	}
}

func TestPackageManagedDefers(t *testing.T) {
	e := setup(t)
	e.s.publish("0.13.0", "stable")
	for method, want := range map[string]string{"homebrew": "brew upgrade caitlyn", "scoop": "scoop update caitlyn", "deb": "apt-get install --only-upgrade caitlyn", "rpm": "dnf upgrade caitlyn", "go": "go install github.com/caitlyn-ai/sdk/cli/cmd/caitlyn@latest", "container": "docker pull ghcr.io/caitlyn-ai/caitlyn:0.13.0"} {
		r := e.run(t.TempDir(), map[string]string{update.MethodEnv: method}, false, "update", "--yes")
		if r.code != 3 || !strings.Contains(r.stderr, want) || !strings.Contains(r.stderr, "UPDATE_BY_PACKAGE_MANAGER") {
			t.Errorf("%s: %d %s", method, r.code, r.stderr)
		}
		if e.binary() != "0.12.0" {
			t.Fatalf("%s: the binary was replaced", method)
		}
	}
	// --check says what to run
	r := e.run(t.TempDir(), map[string]string{update.MethodEnv: "homebrew"}, false, "update", "--check", "-o", "text")
	if !strings.Contains(r.stdout, "Run brew upgrade caitlyn") {
		t.Fatalf("%q", r.stdout)
	}
}

func TestBadSignatureRefusedThroughTheCommand(t *testing.T) {
	e := setup(t)
	e.s.publish("0.13.0", "stable")
	e.s.files["0.13.0/manifest.json.minisig"] = []byte("untrusted comment: nope\nRWQ=\n")
	r := e.run(t.TempDir(), nil, false, "update", "--yes")
	if r.code == 0 || !strings.Contains(r.stderr, update.CodeSignature) || e.binary() != "0.12.0" {
		t.Fatalf("%d %s", r.code, r.stderr)
	}
}

func TestNotice(t *testing.T) {
	e := setup(t)
	e.s.publish("0.13.0", "stable")
	cases := []struct {
		name   string
		vars   map[string]string
		tty    bool
		args   []string
		notice bool
	}{
		{"on a terminal", nil, true, []string{"telemetry", "status"}, true},
		{"no terminal", nil, false, []string{"telemetry", "status"}, false},
		{"CI", map[string]string{"GITLAB_CI": "true"}, true, []string{"telemetry", "status"}, false},
		{"agent mode", map[string]string{"CAITLYN_AGENT": "1"}, true, []string{"telemetry", "status"}, false},
		{"--no-input", nil, true, []string{"telemetry", "status", "--no-input"}, false},
		{"CAITLYN_NO_UPDATE_NOTIFIER", map[string]string{"CAITLYN_NO_UPDATE_NOTIFIER": "1"}, true, []string{"telemetry", "status"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before := e.s.pointers.Load()
			r := e.run(t.TempDir(), c.vars, c.tty, c.args...)
			got := strings.Contains(r.stderr, "caitlyn 0.13.0 is available (you have 0.12.0). Run ")
			if got != c.notice {
				t.Fatalf("notice %v, want %v: %q", got, c.notice, r.stderr)
			}
			if !c.notice && e.s.pointers.Load() != before {
				t.Fatal("where there's no notice, the channel isn't even read")
			}
			if strings.Contains(r.stdout, "is available") {
				t.Fatal("the notice goes on stderr")
			}
		})
	}
	// At most once a day
	home := t.TempDir()
	r := e.run(home, nil, true, "telemetry", "status")
	if !strings.Contains(r.stderr, "is available") {
		t.Fatal("first run today")
	}
	before := e.s.pointers.Load()
	r = e.run(home, nil, true, "telemetry", "status")
	if strings.Contains(r.stderr, "is available") || e.s.pointers.Load() != before {
		t.Fatal("once a day: no second read and no second notice")
	}
	// update_notice = false
	home = t.TempDir()
	_ = os.MkdirAll(filepath.Join(home, ".caitlyn"), 0o700)
	_ = os.WriteFile(filepath.Join(home, ".caitlyn", "config"), []byte("update_notice = false\n"), 0o600)
	if r := e.run(home, nil, true, "telemetry", "status"); strings.Contains(r.stderr, "is available") {
		t.Fatal("update_notice = false")
	}
}

func TestNoticePromptMode(t *testing.T) {
	e := setup(t)
	e.s.publish("0.13.0", "stable")
	home := t.TempDir()
	_ = os.MkdirAll(filepath.Join(home, ".caitlyn"), 0o700)
	_ = os.WriteFile(filepath.Join(home, ".caitlyn", "config"), []byte("update_notice = \"prompt\"\n"), 0o600)
	io, _, errOut := iostreams.Test("y\n")
	io.SetTTY(true, true, true)
	io.Environ = []string{"CAITLYN_CONFIG_DIR=" + filepath.Join(home, ".caitlyn"), "CAITLYN_TELEMETRY=0"}
	code := root.Run(context.Background(), io, []string{"telemetry", "status"}, func(f *cmdutil.Factory) {
		f.Home, f.WorkDir, f.Version = home, home, "0.12.0"
	})
	if code != 0 || !strings.Contains(errOut.String(), "Update to 0.13.0 now?") {
		t.Fatalf("update_notice = prompt asks at the end: %d %q", code, errOut.String())
	}
	if e.binary() != "0.13.0" || !strings.Contains(errOut.String(), "Updated caitlyn 0.12.0 to 0.13.0") {
		t.Fatalf("yes updates: %q", errOut.String())
	}
}

func TestVersionJSON(t *testing.T) {
	e := setup(t)
	r := e.run(t.TempDir(), map[string]string{"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "pull_request"}, false, "version", "--json")
	var v struct {
		Version, SDKVersion, ModelVersion, Go, OS, Arch string
		CI                                              struct {
			Detected    bool
			Provider    string
			PullRequest bool
		}
		Agent struct{ Detected bool }
	}
	if err := json.Unmarshal([]byte(r.stdout), &v); err != nil {
		t.Fatalf("%v %q", err, r.stdout)
	}
	if v.Version != "0.12.0" || v.SDKVersion == "" || v.ModelVersion == "" || !strings.HasPrefix(v.Go, "go") || v.OS == "" || !v.CI.Detected || v.CI.Provider != "github" || !v.CI.PullRequest || v.Agent.Detected {
		t.Fatalf("%+v", v)
	}
	r = e.run(t.TempDir(), nil, true, "version")
	if !strings.HasPrefix(r.stdout, "caitlyn 0.12.0 (Go SDK ") {
		t.Fatalf("%q", r.stdout)
	}
}
