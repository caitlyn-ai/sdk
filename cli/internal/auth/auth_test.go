package auth_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/auth"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

const ws = "acme.caitlyn.ai"

func TestMain(m *testing.M) {
	// Never the real keychain: every test runs against go-keyring's in-memory mock
	keyring.MockInit()
	commands.Register()
	os.Exit(m.Run())
}

// harness runs the CLI in-process against a fake workspace, with a temporary HOME and CAITLYN_CONFIG_DIR.
type harness struct {
	t    *testing.T
	fake *fakeOAuth
	home string
	dir  string
	env  []string
	tty  bool
	// memory sends the command's requests to the fake through its in-memory transport (the factory's HTTPClient),
	// for a run inside a synctest bubble.
	memory bool
	// opened is every URL the CLI asked a browser to open.
	mu     sync.Mutex
	opened []string
}

type result struct {
	code        int
	out, errOut string
}

// problem is the error the CLI printed as JSON on stderr.
func (r result) problem(t *testing.T) map[string]any {
	t.Helper()
	var p struct {
		Error map[string]any `json:"error"`
	}
	lines := strings.Split(strings.TrimSpace(r.errOut), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &p); err != nil || p.Error == nil {
		t.Fatalf("stderr is not a problem: %q", r.errOut)
	}
	return p.Error
}

func newHarness(t *testing.T) *harness {
	keyring.MockInit()
	home := t.TempDir()
	h := &harness{t: t, fake: newFakeOAuth(t, ws), home: home, dir: filepath.Join(home, ".caitlyn")}
	// The browser "approves" by following the authorisation URL: the fake redirects to the CLI's loopback listener
	t.Cleanup(auth.SetOpenBrowser(func(_ context.Context, _ string, u string) error {
		h.mu.Lock()
		h.opened = append(h.opened, u)
		h.mu.Unlock()
		go func() {
			resp, err := http.Get(u)
			if err == nil {
				resp.Body.Close()
			}
		}()
		return nil
	}))
	return h
}

func (h *harness) run(stdin string, args ...string) result {
	h.t.Helper()
	io, out, errOut := iostreams.Test(stdin)
	io.Environ = append([]string{
		"CAITLYN_CONFIG_DIR=" + h.dir, "HOME=" + h.home, "CAITLYN_ENDPOINT=" + h.fake.srv.URL + "/api",
		"CAITLYN_TELEMETRY=false", "CAITLYN_NO_UPDATE_NOTIFIER=1",
	}, h.env...)
	if h.tty {
		io.SetTTY(true, true, true)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	code := root.Run(ctx, io, args, func(f *cmdutil.Factory) {
		f.Home, f.WorkDir = h.home, h.home
		if h.memory {
			f.HTTPClient = h.fake.inMemory()
		}
	})
	return result{code: code, out: out.String(), errOut: errOut.String()}
}

func (h *harness) mustRun(stdin string, args ...string) result {
	h.t.Helper()
	r := h.run(stdin, args...)
	if r.code != 0 {
		h.t.Fatalf("caitlyn %s: exit %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), r.code, r.out, r.errOut)
	}
	return r
}

func (h *harness) login(args ...string) result {
	h.t.Helper()
	return h.mustRun("", append([]string{"auth", "login", "--workspace", ws}, args...)...)
}

func (h *harness) configFile() string {
	b, _ := os.ReadFile(filepath.Join(h.dir, "config"))
	return string(b)
}

func personKey(profile string) string { return "caitlyn:" + ws + ":" + profile }

func stored(t *testing.T, key string) *auth.Entry {
	t.Helper()
	v, err := keyring.Get(auth.KeyringService, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var e auth.Entry
	if err := json.Unmarshal([]byte(v), &e); err != nil {
		t.Fatal(err)
	}
	// the tokens are items of their own
	if a, err := keyring.Get(auth.KeyringService, key+":access"); err == nil && e.AccessToken == "" {
		e.AccessToken = a
	}
	if r, err := keyring.Get(auth.KeyringService, key+":refresh"); err == nil && e.RefreshToken == "" {
		e.RefreshToken = r
	}
	return &e
}

func statusJSON(t *testing.T, r result) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(r.out), &m); err != nil {
		t.Fatalf("auth status -o json: %v\n%s", err, r.out)
	}
	return m
}

// ---------------------------------------------------------------- browser sign-in, PKCE

func TestBrowserLoginLoopbackPKCE(t *testing.T) {
	h := newHarness(t)
	r := h.login("--output-default", "json", "--agent-scopes", "read-only")
	if !strings.Contains(r.errOut, "Signed in to "+ws+" as Aroha Ngata") {
		t.Errorf("no success line: %s", r.errOut)
	}
	if !strings.Contains(r.errOut, "Not opened? ") {
		t.Errorf("the URL isn't printed in case the browser didn't open: %s", r.errOut)
	}
	var q url.Values
	h.fake.with(func(f *fakeOAuth) { q = f.authorizeQ[0] })
	redirect := q.Get("redirect_uri")
	if !loopbackRE.MatchString(redirect) {
		t.Fatalf("redirect %q is not 127.0.0.1 on a port with /callback", redirect)
	}
	if q.Get("scope") != "api:admin" || q.Get("client_id") != "caitlyn-cli" || q.Get("resource") != "https://"+ws+"/api" {
		t.Errorf("authorisation request: %v", q)
	}
	var ex url.Values
	h.fake.with(func(f *fakeOAuth) { ex = f.codeExchange[0] })
	if v := ex.Get("code_verifier"); len(v) < 43 || len(v) > 128 || strings.ContainsAny(v, "+/=") {
		t.Errorf("PKCE verifier %q is not RFC 7636's form", v)
	}
	// The listener accepted one request and closed
	u, _ := url.Parse(redirect)
	if c, err := net.DialTimeout("tcp", u.Host, time.Second); err == nil {
		c.Close()
		t.Errorf("the loopback listener %s is still open", u.Host)
	}
	e := stored(t, personKey("default"))
	if e == nil || e.Kind != "oauth" || e.RefreshToken == "" || e.Scope != "api:admin" {
		t.Fatalf("stored entry: %+v", e)
	}
	cfg := h.configFile()
	for _, want := range []string{`workspace = "` + ws + `"`, `auth = "oauth"`, `output = "json"`, `agent_scopes = "read-only"`} {
		if !strings.Contains(cfg, want) {
			t.Errorf("config lacks %s:\n%s", want, cfg)
		}
	}
	if strings.Contains(cfg, e.RefreshToken) || strings.Contains(cfg, e.AccessToken) {
		t.Error("a token was written to the config file")
	}
	// A second sign-in listens on a port of its own choosing too
	h.login("--profile", "second")
	h.fake.with(func(f *fakeOAuth) { q = f.authorizeQ[1] })
	if !loopbackRE.MatchString(q.Get("redirect_uri")) {
		t.Errorf("second redirect %q", q.Get("redirect_uri"))
	}
}

// A callback with the wrong state is answered 400 and ignored: the listener keeps waiting for the real one, so a
// forged request can neither sign the person in nor cancel their sign-in.
func TestBrowserLoginStateChecked(t *testing.T) {
	h := newHarness(t)
	forged := make(chan int, 1)
	t.Cleanup(auth.SetOpenBrowser(func(_ context.Context, _ string, u string) error {
		pu, _ := url.Parse(u)
		redirect := pu.Query().Get("redirect_uri")
		go func() {
			status := 0
			if resp, err := http.Get(redirect + "?code=stolen&state=not-the-one-sent"); err == nil {
				status = resp.StatusCode
				resp.Body.Close()
			}
			forged <- status
			if resp, err := http.Get(u); err == nil {
				resp.Body.Close()
			}
		}()
		return nil
	}))
	r := h.run("", "auth", "login", "--workspace", ws)
	if got := <-forged; got != http.StatusBadRequest {
		t.Errorf("the forged callback got %d, want 400", got)
	}
	if r.code != 0 {
		t.Fatalf("the real callback still signs in: exit %d: %s", r.code, r.errOut)
	}
	h.fake.with(func(f *fakeOAuth) {
		for _, c := range f.codeExchange {
			if c.Get("code") == "stolen" {
				t.Error("the forged code was exchanged")
			}
		}
	})
}

// ---------------------------------------------------------------- the three questions

func TestLoginAsksTheThreeQuestionsAtATerminal(t *testing.T) {
	h := newHarness(t)
	h.tty = true
	// Always JSON; JSON for agents; Choose scopes…, then the first two (agents:read, agents:write)
	h.mustRun("2\n1\n4\n1,2\n", "auth", "login", "--workspace", ws)
	cfg := h.configFile()
	for _, want := range []string{`output = "json"`, `agent_output = "json"`, `agent_scopes = ["agents:read", "agents:write"]`} {
		if !strings.Contains(cfg, want) {
			t.Errorf("config lacks %s:\n%s", want, cfg)
		}
	}
}

func TestLoginWithoutTerminalSavesOnlyFlags(t *testing.T) {
	h := newHarness(t)
	h.login()
	cfg := h.configFile()
	for _, unwanted := range []string{"output", "agent_scopes"} {
		if strings.Contains(cfg, unwanted) {
			t.Errorf("config has %s without a flag or a terminal:\n%s", unwanted, cfg)
		}
	}
}

func TestLoginRefusedInCI(t *testing.T) {
	h := newHarness(t)
	h.env = []string{"GITLAB_CI=true", "CI=true"}
	r := h.run("", "auth", "login", "--workspace", ws)
	if r.code != 2 || r.problem(t)["code"] != "LOGIN_IN_CI" {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
}

// ---------------------------------------------------------------- refresh rotation, and two at once

func TestRefreshRotation(t *testing.T) {
	h := newHarness(t)
	h.fake.with(func(f *fakeOAuth) { f.expiresIn = 30 }) // inside the minute: every run refreshes
	h.login()
	first := stored(t, personKey("default")).RefreshToken
	h.mustRun("", "auth", "status", "-o", "json")
	second := stored(t, personKey("default")).RefreshToken
	h.mustRun("", "auth", "status", "-o", "json")
	third := stored(t, personKey("default")).RefreshToken
	if first == second || second == third {
		t.Errorf("refresh tokens didn't rotate: %s %s %s", first, second, third)
	}
	h.fake.with(func(f *fakeOAuth) {
		if len(f.refreshes) != 2 || f.reuse != 0 {
			t.Errorf("%d refreshes, %d reused", len(f.refreshes), f.reuse)
		}
		if f.refreshes[0].Get("refresh_token") != first || f.refreshes[1].Get("refresh_token") != second {
			t.Error("a refresh didn't send the latest refresh token")
		}
		if f.refreshes[0].Has("scope") {
			t.Error("a person's refresh asked for a scope")
		}
	})
}

func TestTwoProcessesRefreshOnce(t *testing.T) {
	h := newHarness(t)
	h.fake.with(func(f *fakeOAuth) { f.expiresIn = 30 })
	h.login("--insecure-storage")
	// The first refresh is held at the server, inside the first process's lock, until the second process has started
	// its own Token call: the second has to wait for the lock, then use what the first saved.
	arrived, release := make(chan struct{}), make(chan struct{})
	h.fake.with(func(f *fakeOAuth) { f.expiresIn = 3600; f.refreshArrived, f.refreshRelease = arrived, release })
	endpoint := h.fake.srv.URL + "/api"
	a := auth.PersonTokenFunc(h.dir, endpoint, ws, "default", true)
	b := auth.PersonTokenFunc(h.dir, endpoint, ws, "default", true)
	var wg sync.WaitGroup
	toks, errs := make([]string, 2), make([]error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		toks[0], errs[0] = a(context.Background())
	}()
	<-arrived // the first holds the lock, its refresh under way
	started := make(chan struct{})
	go func() {
		defer wg.Done()
		close(started)
		toks[1], errs[1] = b(context.Background())
	}()
	<-started
	close(release)
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if toks[0] != toks[1] {
		t.Errorf("the two got different tokens: %v", toks)
	}
	h.fake.with(func(f *fakeOAuth) {
		if len(f.refreshes) != 1 || f.reuse != 0 {
			t.Errorf("%d refreshes sent, %d reused; want one, none reused", len(f.refreshes), f.reuse)
		}
	})
	if _, err := os.Stat(filepath.Join(h.dir, ".lock-default")); err != nil {
		t.Errorf("no lock file beside the config: %v", err)
	}
}

// ---------------------------------------------------------------- device flow

// The device flow runs on synctest's clock, with the fake reached through an in-memory transport: the waits between
// polls are the real RFC 8628 ones (the server's 5-second interval, five seconds more after slow_down), and the fake
// records when each poll arrives, so the gaps are exact.
func TestDeviceFlow(t *testing.T) {
	cases := []struct {
		name   string
		script []string
		exit   int
		code   string
		// gaps are the waits before each poll: after the device authorisation, then after each poll before it.
		gaps []time.Duration
	}{
		{"pending then slow_down then approved", []string{"authorization_pending", "slow_down", "ok"}, 0, "", []time.Duration{5 * time.Second, 5 * time.Second, 10 * time.Second}},
		{"access_denied", []string{"authorization_pending", "access_denied"}, 4, "access_denied", []time.Duration{5 * time.Second, 5 * time.Second}},
		{"expired_token", []string{"expired_token"}, 4, "expired_token", []time.Duration{5 * time.Second}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// The fake's server and the keychain mock are made outside the bubble; the run, and its clock, inside it
			h := newHarness(t)
			h.memory = true
			h.fake.with(func(f *fakeOAuth) { f.deviceScript = c.script })
			synctest.Test(t, func(t *testing.T) {
				r := h.run("", "auth", "login", "--workspace", ws, "--device")
				if r.code != c.exit {
					t.Fatalf("exit %d, want %d: %s", r.code, c.exit, r.errOut)
				}
				if !strings.Contains(r.errOut, "BCDF-GHJK") {
					t.Errorf("the code isn't shown: %s", r.errOut)
				}
				h.fake.with(func(f *fakeOAuth) {
					var gaps []time.Duration
					last := f.deviceStartedAt
					for _, at := range f.devicePolledAt {
						gaps = append(gaps, at.Sub(last)) // timers: virtual (synctest)
						last = at
					}
					if len(gaps) != len(c.gaps) {
						t.Fatalf("waits before each poll %v, want %v", gaps, c.gaps)
					}
					for i := range gaps {
						if gaps[i] != c.gaps[i] {
							t.Errorf("waits before each poll %v, want %v (slow_down adds five seconds)", gaps, c.gaps)
						}
					}
				})
				if c.exit == 0 {
					if stored(t, personKey("default")) == nil {
						t.Error("no tokens saved")
					}
					h.fake.with(func(f *fakeOAuth) {
						s := f.deviceStarts[0]
						if s.Get("client_id") != "caitlyn-cli" || s.Get("resource") != "https://"+ws+"/api" {
							t.Errorf("device authorisation request: %v", s)
						}
					})
					return
				}
				if p := r.problem(t); p["code"] != c.code {
					t.Errorf("code %v, want %s", p["code"], c.code)
				}
				if stored(t, personKey("default")) != nil {
					t.Error("tokens saved after a failed device sign-in")
				}
			})
		})
	}
}

// ---------------------------------------------------------------- storage

func TestKeychainUnavailable(t *testing.T) {
	h := newHarness(t)
	keyring.MockInitWithError(errors.New("org.freedesktop.secrets was not provided by any .service files"))
	t.Cleanup(keyring.MockInit)
	r := h.run("", "auth", "login", "--workspace", ws)
	if r.code == 0 {
		t.Fatal("sign-in succeeded with no keychain")
	}
	p := r.problem(t)
	if p["code"] != "KEYCHAIN_UNAVAILABLE" || !strings.Contains(r.errOut, "--insecure-storage") {
		t.Errorf("problem %v", p)
	}
	h.fake.with(func(f *fakeOAuth) {
		if len(f.authorizeQ) != 0 {
			t.Error("the person was sent to approve before storage was checked")
		}
	})

	h.login("--insecure-storage")
	path := filepath.Join(h.dir, "credentials")
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("credentials mode %v, want 0600", st.Mode().Perm())
	}
	b, _ := os.ReadFile(path)
	// the refresh token is an item of its own, beside the entry
	if !strings.Contains(string(b), `:default:refresh": "rt-`) {
		t.Errorf("credentials file: %s", b)
	}
	if !strings.Contains(h.configFile(), "insecure_storage = true") {
		t.Errorf("profile doesn't record insecure storage:\n%s", h.configFile())
	}
	m := statusJSON(t, h.mustRun("", "auth", "status", "-o", "json"))
	if cred := m["credential"].(map[string]any); cred["insecureStorage"] != true {
		t.Errorf("status credential %v", cred)
	}
	h.tty = true
	if r := h.mustRun("", "auth", "status"); !strings.Contains(r.out, "Insecure storage") {
		t.Errorf("auth status doesn't say storage is insecure:\n%s", r.out)
	}
}

// ---------------------------------------------------------------- sign-out

func TestLogoutRevokes(t *testing.T) {
	h := newHarness(t)
	h.login()
	rt := stored(t, personKey("default")).RefreshToken
	h.mustRun("", "auth", "logout")
	h.fake.with(func(f *fakeOAuth) {
		if len(f.revoked) != 1 || f.revoked[0] != rt {
			t.Errorf("revoked %v, want [%s]", f.revoked, rt)
		}
	})
	if stored(t, personKey("default")) != nil {
		t.Error("tokens are still stored")
	}
	if r := h.run("", "auth", "status"); r.code != 4 {
		t.Errorf("status after logout: exit %d", r.code)
	}
	// Signing out again has nothing to do
	h.mustRun("", "auth", "logout")
}

// ---------------------------------------------------------------- tokens, switching, modes

func TestWithTokenAndAuthToken(t *testing.T) {
	h := newHarness(t)
	h.fake.addToken("pat-123", "api:read")
	h.mustRun("pat-123\n", "auth", "login", "--workspace", ws, "--with-token")
	if !strings.Contains(h.configFile(), `auth = "token"`) {
		t.Errorf("config:\n%s", h.configFile())
	}
	if r := h.mustRun("", "auth", "token"); strings.TrimSpace(r.out) != "pat-123" {
		t.Errorf("auth token printed %q", r.out)
	}
	m := statusJSON(t, h.mustRun("", "auth", "status", "-o", "json"))
	if m["credential"].(map[string]any)["mode"] != "token" {
		t.Errorf("status %v", m)
	}
	// A token the workspace refuses is never saved
	h2 := newHarness(t)
	if r := h2.run("bad-token", "auth", "login", "--workspace", ws, "--with-token"); r.code != 4 {
		t.Errorf("bad token: exit %d %s", r.code, r.errOut)
	}
	if stored(t, personKey("default")) != nil {
		t.Error("a refused token was saved")
	}
}

func TestSwitch(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.login("--profile", "staging")
	h.mustRun("", "auth", "switch", "staging")
	if !strings.Contains(h.configFile(), `default_profile = "staging"`) {
		t.Errorf("config:\n%s", h.configFile())
	}
	if r := h.run("", "auth", "switch", "nope"); r.code != 2 {
		t.Errorf("unknown profile: exit %d", r.code)
	}
}

func TestTopLevelLoginAlias(t *testing.T) {
	h := newHarness(t)
	h.mustRun("", "login", "--workspace", ws)
	if stored(t, personKey("default")) == nil {
		t.Error("login didn't sign in")
	}
}

func TestTwoCredentialsIsUsageError(t *testing.T) {
	h := newHarness(t)
	h.env = []string{"CAITLYN_WORKSPACE=" + ws, "CAITLYN_TOKEN=t", "CAITLYN_CLIENT_ID=c", "CAITLYN_CLIENT_SECRET=s"}
	r := h.run("", "auth", "status")
	if r.code != 2 || r.problem(t)["code"] != "TWO_CREDENTIALS" {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	h.env = []string{"CAITLYN_WORKSPACE=" + ws, "CAITLYN_AUTH=aws-iam", "CAITLYN_TOKEN=t"}
	if r := h.run("", "auth", "status"); r.code != 2 {
		t.Errorf("CAITLYN_AUTH against another credential: exit %d", r.code)
	}
}

// ---------------------------------------------------------------- workload identity

func TestWorkloadIdentityFromGitLab(t *testing.T) {
	h := newHarness(t)
	h.env = []string{"GITLAB_CI=true", "CI=true", "CAITLYN_WORKSPACE=" + ws, "CAITLYN_AUTH=workload-identity", "CAITLYN_ID_TOKEN=gitlab-jwt"}
	m := statusJSON(t, h.mustRun("", "auth", "status", "-o", "json"))
	if m["credential"].(map[string]any)["mode"] != "workload-identity" {
		t.Errorf("status %v", m)
	}
	h.fake.with(func(f *fakeOAuth) {
		if len(f.exchanges) != 1 {
			t.Fatalf("%d exchanges", len(f.exchanges))
		}
		x := f.exchanges[0]
		if x.Get("subject_token") != "gitlab-jwt" || x.Get("resource") != "https://"+ws+"/api" {
			t.Errorf("exchange %v", x)
		}
	})
	// CAITLYN_ID_TOKEN alone is enough: the mode follows the credential
	h.env = []string{"GITLAB_CI=true", "CAITLYN_WORKSPACE=" + ws, "CAITLYN_ID_TOKEN=gitlab-jwt"}
	h.mustRun("", "auth", "status", "-o", "json")
}

func TestWorkloadIdentityFromGitHub(t *testing.T) {
	h := newHarness(t)
	h.env = []string{"GITHUB_ACTIONS=true", "CI=true", "CAITLYN_WORKSPACE=" + ws, "CAITLYN_AUTH=workload-identity",
		"ACTIONS_ID_TOKEN_REQUEST_URL=" + h.fake.srv.URL + "/gh/token?api-version=2.0", "ACTIONS_ID_TOKEN_REQUEST_TOKEN=gh-request-token"}
	h.mustRun("", "auth", "status", "-o", "json")
	h.mustRun("", "auth", "status", "-o", "json")
	h.fake.with(func(f *fakeOAuth) {
		if len(f.ghRequests) != 2 {
			t.Errorf("GitHub asked %d times, want a fresh token at each sign-in", len(f.ghRequests))
		}
		if q := f.ghRequests[0].URL.Query(); q.Get("api-version") != "2.0" || q.Get("audience") != "https://"+ws+"/api" {
			t.Errorf("GitHub request %v", q)
		}
		if len(f.exchanges) != 2 || f.exchanges[0].Get("subject_token") != "gh-jwt" {
			t.Errorf("exchanges %v", f.exchanges)
		}
	})
}

func TestWorkloadIdentityFromBuildkite(t *testing.T) {
	h := newHarness(t)
	h.env = []string{"BUILDKITE=true", "CAITLYN_WORKSPACE=" + ws, "CAITLYN_AUTH=workload-identity"}
	calls := 0
	t.Cleanup(auth.SetRunCommand(func(_ context.Context, name string, args ...string) ([]byte, int, error) {
		calls++
		if name != "buildkite-agent" || strings.Join(args, " ") != "oidc request-token --audience https://"+ws+"/api" {
			t.Errorf("ran %s %v", name, args)
		}
		return nil, 77, errors.New("refused")
	}))
	if r := h.run("", "auth", "status", "-o", "json"); r.code != 4 {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	if calls != 1 {
		t.Errorf("buildkite-agent ran %d times; exit 77 is never retried", calls)
	}
	t.Cleanup(auth.SetRunCommand(func(context.Context, string, ...string) ([]byte, int, error) {
		return []byte("bk-jwt\n"), 0, nil
	}))
	h.mustRun("", "auth", "status", "-o", "json")
}

// ---------------------------------------------------------------- agent mode (18.5)

func agentKey(scopes ...string) string { return agent.CacheKey(ws, "default", scopes) }

func TestAgentNarrowerRefreshAndSeparateCache(t *testing.T) {
	h := newHarness(t)
	h.login()
	person := stored(t, personKey("default"))
	h.env = []string{"CAITLYN_AGENT=1"}
	m := statusJSON(t, h.mustRun("", "auth", "status"))
	h.fake.with(func(f *fakeOAuth) {
		if len(f.refreshes) != 1 || f.refreshes[0].Get("scope") != "api:read" || f.refreshes[0].Get("refresh_token") != person.RefreshToken {
			t.Fatalf("agent refresh: %v", f.refreshes)
		}
		last := f.meBearers[len(f.meBearers)-1]
		if last == person.AccessToken {
			t.Error("the agent's command used the person's access token")
		}
	})
	a := stored(t, agentKey("api:read"))
	if a == nil || a.Kind != "agent" {
		t.Fatalf("no agent token under %s", agentKey("api:read"))
	}
	after := stored(t, personKey("default"))
	if after.AccessToken != person.AccessToken || after.RefreshToken == person.RefreshToken {
		t.Errorf("person's entry: access kept %v, refresh rotated %v", after.AccessToken == person.AccessToken, after.RefreshToken != person.RefreshToken)
	}
	ag := m["agent"].(map[string]any)
	if ag["serverNarrowed"] != false || ag["enforcement"] != "cli" || ag["active"] != true {
		t.Errorf("agent status (server returned the wider scope): %v", ag)
	}
	// Cached: the next agent command refreshes nothing
	h.mustRun("", "auth", "status")
	h.fake.with(func(f *fakeOAuth) {
		if len(f.refreshes) != 1 {
			t.Errorf("%d refreshes; the agent token should be cached", len(f.refreshes))
		}
	})
	// A person's command still uses the person's token
	h.env = nil
	h.mustRun("", "auth", "status", "-o", "json")
	h.fake.with(func(f *fakeOAuth) {
		if f.meBearers[len(f.meBearers)-1] != person.AccessToken {
			t.Error("a person's command didn't use the person's token")
		}
	})
}

func TestAgentScopeMissingFromResponse(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.with(func(f *fakeOAuth) { f.scopeMode = "missing" })
	h.env = []string{"CAITLYN_AGENT=1"}
	m := statusJSON(t, h.mustRun("", "auth", "status"))
	if m["agent"].(map[string]any)["serverNarrowed"] != false {
		t.Errorf("a response with no scope counted as narrowed: %v", m["agent"])
	}
}

func TestAgentServerHonoursScope(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.with(func(f *fakeOAuth) { f.scopeMode = "honour" })
	h.env = []string{"CAITLYN_AGENT=1"}
	m := statusJSON(t, h.mustRun("", "auth", "status"))
	ag := m["agent"].(map[string]any)
	if ag["serverNarrowed"] != true || ag["enforcement"] != "server" {
		t.Errorf("agent status: %v", ag)
	}
	// The person's status reads the agent token's result
	h.env = nil
	m = statusJSON(t, h.mustRun("", "auth", "status", "-o", "json"))
	if m["agent"].(map[string]any)["enforcement"] != "server" {
		t.Errorf("person's view: %v", m["agent"])
	}
}

func TestAgentScopesChangeDeletesOldToken(t *testing.T) {
	h := newHarness(t)
	h.login("--agent-scopes", "read-only")
	h.env = []string{"CAITLYN_AGENT=1"}
	h.mustRun("", "auth", "status")
	if stored(t, agentKey("api:read")) == nil {
		t.Fatal("no agent token")
	}
	// The person changes agent_scopes with caitlyn config set (a person, not the agent: only a person may)
	h.env = nil
	h.mustRun("", "config", "set", "agent_scopes", "agents:write")
	if !strings.Contains(h.configFile(), `agent_scopes = ["agents:write"]`) {
		t.Fatalf("config set didn't write the profile's agent_scopes:\n%s", h.configFile())
	}
	h.env = []string{"CAITLYN_AGENT=1"}
	h.mustRun("", "auth", "status")
	if stored(t, agentKey("api:read")) != nil {
		t.Error("the old agent token wasn't deleted")
	}
	if stored(t, agentKey("agents:write")) == nil {
		t.Error("no token for the new agent scopes")
	}
}

func TestAgentScopesChangeViaLogin(t *testing.T) {
	h := newHarness(t)
	h.login("--agent-scopes", "read-only")
	h.env = []string{"CAITLYN_AGENT=1"}
	h.mustRun("", "auth", "status")
	if stored(t, agentKey("api:read")) == nil {
		t.Fatal("no agent token")
	}
	// Another sign-in is a new grant: the old agent token goes
	h.env = nil
	h.login("--agent-scopes", "agents:read,knowledge-bases:write")
	if stored(t, agentKey("api:read")) != nil {
		t.Error("the agent token from the old grant wasn't deleted")
	}
	h.env = []string{"CAITLYN_AGENT=1"}
	h.mustRun("", "auth", "status")
	h.fake.with(func(f *fakeOAuth) {
		if got := f.refreshes[len(f.refreshes)-1].Get("scope"); got != "agents:read knowledge-bases:write" {
			t.Errorf("scope %q", got)
		}
	})
}

func TestAgentNoneRefused(t *testing.T) {
	h := newHarness(t)
	h.login("--agent-scopes", "none")
	h.env = []string{"CAITLYN_AGENT=1"}
	r := h.run("", "auth", "status")
	if r.code != 5 || r.problem(t)["code"] != "AGENT_NOT_ALLOWED" {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	h.fake.with(func(f *fakeOAuth) {
		if len(f.refreshes) != 0 {
			t.Error("a refresh was sent for a refused agent")
		}
	})
}

func TestAgentReadOnlyCaps(t *testing.T) {
	t.Run("CAITLYN_READ_ONLY caps full", func(t *testing.T) {
		h := newHarness(t)
		h.login("--agent-scopes", "full")
		h.env = []string{"CAITLYN_AGENT=1", "CAITLYN_READ_ONLY=1"}
		h.mustRun("", "auth", "status")
		h.fake.with(func(f *fakeOAuth) {
			if got := f.refreshes[0].Get("scope"); got != "api:read" {
				t.Errorf("scope %q, want api:read", got)
			}
		})
	})
	t.Run("a read-only profile caps a list", func(t *testing.T) {
		h := newHarness(t)
		h.login("--read-only", "--agent-scopes", "agents:write")
		if !strings.Contains(h.configFile(), "read_only = true") {
			t.Fatalf("config:\n%s", h.configFile())
		}
		h.env = []string{"CAITLYN_AGENT=1"}
		h.mustRun("", "auth", "status")
		h.fake.with(func(f *fakeOAuth) {
			if got := f.refreshes[0].Get("scope"); got != "agents:read" {
				t.Errorf("scope %q, want agents:read", got)
			}
		})
	})
	t.Run("without either, full is the grant", func(t *testing.T) {
		h := newHarness(t)
		h.login("--agent-scopes", "full")
		h.env = []string{"CAITLYN_AGENT=1"}
		h.mustRun("", "auth", "status")
		h.fake.with(func(f *fakeOAuth) {
			if got := f.refreshes[0].Get("scope"); got != "api:admin" {
				t.Errorf("scope %q, want api:admin", got)
			}
		})
	})
}

func TestAgentRefusedTokenAndDevice(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.env = []string{"CAITLYN_AGENT=1"}
	r := h.run("", "auth", "token")
	if r.code != 5 || strings.Contains(r.out, "at-") {
		t.Errorf("auth token in agent mode: exit %d, stdout %q", r.code, r.out)
	}
	r = h.run("", "auth", "login", "--workspace", ws, "--device")
	if r.code != 5 || r.problem(t)["code"] != "DEVICE_SIGN_IN_REFUSED" {
		t.Errorf("device sign-in in agent mode: exit %d %s", r.code, r.errOut)
	}
	h.fake.with(func(f *fakeOAuth) {
		if len(f.deviceStarts) != 0 {
			t.Error("a device code was requested")
		}
	})
}

func TestAgentNeverFallsBackToPersonToken(t *testing.T) {
	h := newHarness(t)
	h.login()
	person := stored(t, personKey("default"))
	var before int
	h.fake.with(func(f *fakeOAuth) { f.refuseRefresh = true; before = len(f.meBearers) })
	h.env = []string{"CAITLYN_AGENT=1"}
	r := h.run("", "auth", "status")
	if r.code != 4 {
		t.Fatalf("exit %d: %s", r.code, r.errOut)
	}
	h.fake.with(func(f *fakeOAuth) {
		for _, b := range f.meBearers[before:] {
			if b == person.AccessToken {
				t.Error("the person's token was sent in agent mode after the agent's refresh failed")
			}
		}
	})
}

func TestPersonStatusHuman(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.tty = true
	r := h.mustRun("", "auth", "status")
	lines := strings.Split(r.out, "\n")
	if !strings.Contains(lines[0], ws) || !strings.Contains(lines[0], "(profile default)") || strings.Contains(lines[0], "Signed in") {
		t.Errorf("the workspace isn't first:\n%s", r.out)
	}
	for _, want := range []string{"Aroha Ngata", "OAuth (Caitlyn CLI), scopes api:admin", "expires in", "Agent scopes", "Caitlyn 5.144.0"} {
		if !strings.Contains(r.out, want) {
			t.Errorf("status lacks %q:\n%s", want, r.out)
		}
	}
	if r := h.mustRun("", "auth", "token"); !strings.HasPrefix(strings.TrimSpace(r.out), "at-") {
		t.Errorf("auth token printed %q", r.out)
	}
}

// Against the server's rule for narrower refreshes (app !2138, round 5, I1): when the person picked areas at
// consent, the grant names them and its api: scope is only a ceiling, so a refresh asking for api:read is refused.
// The read-only agent asks for each granted area at read instead, and a bare surface grant still asks for api:read.
func TestAgentScopesMatchTheServersNarrowingRule(t *testing.T) {
	t.Run("a grant that names areas", func(t *testing.T) {
		h := newHarness(t)
		h.fake.with(func(f *fakeOAuth) {
			f.granted = "agents:write knowledge-bases:read api:write"
			f.scopeMode = "server"
		})
		h.login()
		h.env = []string{"CAITLYN_AGENT=1"}
		h.mustRun("", "auth", "status")
		h.fake.with(func(f *fakeOAuth) {
			if len(f.refreshes) != 1 || f.refreshes[0].Get("scope") != "agents:read knowledge-bases:read" {
				t.Fatalf("refreshes %v, want one asking agents:read knowledge-bases:read", f.refreshes)
			}
		})
		a := stored(t, agentKey("agents:read", "knowledge-bases:read"))
		if a == nil || a.Scope != "agents:read knowledge-bases:read" || !a.Narrowed {
			t.Fatalf("the agent token, its echoed scope and Narrowed: %+v", a)
		}
		ag := statusJSON(t, h.mustRun("", "auth", "status"))["agent"].(map[string]any)
		if ag["serverNarrowed"] != true || ag["enforcement"] != "server" {
			t.Errorf("auth status says the workspace enforces it: %v", ag)
		}
		// the same server refuses what the CLI used to ask for
		if serverAllows(strings.Fields("agents:write knowledge-bases:read api:write"), []string{"api:read"}) {
			t.Fatal("the fake's rule must refuse api:read against a grant that names areas")
		}
	})
	t.Run("full against areas sends the grant exactly", func(t *testing.T) {
		h := newHarness(t)
		h.fake.with(func(f *fakeOAuth) {
			f.granted = "agents:write knowledge-bases:read api:write"
			f.scopeMode = "server"
		})
		h.login("--agent-scopes", "full")
		h.env = []string{"CAITLYN_AGENT=1"}
		h.mustRun("", "auth", "status")
		h.fake.with(func(f *fakeOAuth) {
			if len(f.refreshes) != 1 || f.refreshes[0].Get("scope") != "agents:write api:write knowledge-bases:read" {
				t.Fatalf("refreshes %v, want the grant", f.refreshes)
			}
		})
		if a := stored(t, agentKey("agents:write", "api:write", "knowledge-bases:read")); a == nil || !a.Narrowed {
			t.Fatalf("the agent token for the grant, echoed as asked: %+v", a)
		}
	})
	t.Run("a list of an area and api:read asks for that area only", func(t *testing.T) {
		h := newHarness(t)
		h.fake.with(func(f *fakeOAuth) {
			f.granted = "agents:write knowledge-bases:read users:write api:write"
			f.scopeMode = "server"
		})
		h.login("--agent-scopes", "agents:read,api:read")
		h.env = []string{"CAITLYN_AGENT=1"}
		h.mustRun("", "auth", "status")
		h.fake.with(func(f *fakeOAuth) {
			if len(f.refreshes) != 1 || f.refreshes[0].Get("scope") != "agents:read" {
				t.Fatalf("refreshes %v, want one asking agents:read", f.refreshes)
			}
		})
		if a := stored(t, agentKey("agents:read")); a == nil || a.Scope != "agents:read" || !a.Narrowed {
			t.Fatalf("the agent token: %+v", a)
		}
	})
	t.Run("a bare surface grant", func(t *testing.T) {
		h := newHarness(t)
		h.fake.with(func(f *fakeOAuth) {
			f.granted = "api:write"
			f.scopeMode = "server"
		})
		h.login()
		h.env = []string{"CAITLYN_AGENT=1"}
		h.mustRun("", "auth", "status")
		h.fake.with(func(f *fakeOAuth) {
			if len(f.refreshes) != 1 || f.refreshes[0].Get("scope") != "api:read" {
				t.Fatalf("refreshes %v, want one asking api:read", f.refreshes)
			}
		})
		if a := stored(t, agentKey("api:read")); a == nil || a.Scope != "api:read" || !a.Narrowed {
			t.Fatalf("the agent token: %+v", a)
		}
	})
}

// The fake's copy of the server's rule, row by row from the app's review: what it refuses and what it narrows.
func TestServerNarrowingRule(t *testing.T) {
	for _, c := range []struct {
		grant, asked string
		ok           bool
	}{
		{"agents:read api:read", "api:read", false},
		{"agents:write knowledge-bases:read api:write", "api:read", false},
		{"agents:write knowledge-bases:read api:write", "knowledge-bases:write", false},
		{"agents:write api:write", "users:write", false},
		{"agents:write api:write", "roles:write", false},
		{"agents:read mcp:read", "mcp:read", false},
		{"agents:write knowledge-bases:read api:write", "agents:read knowledge-bases:read", true},
		{"agents:write knowledge-bases:read api:write", "agents:write knowledge-bases:read api:write", true},
		{"agents:write knowledge-bases:read api:write", "agents:read api:read", true},
		{"agents:write api:read", "agents:write", false}, // the ceiling
		{"agents:write api:read", "agents:read", true},
		{"mcp:read", "agents:read", true}, // a bare mcp: grant covers families on the server
		{"mcp:read", "api:read", false},
		{"api:write", "api:read", true},
		{"api:write", "agents:read", true},
	} {
		if serverAllows(strings.Fields(c.grant), strings.Fields(c.asked)) != c.ok {
			t.Errorf("grant %q, asked %q: want %v", c.grant, c.asked, c.ok)
		}
	}
}

// --agent-scopes refuses mcp: and a family that doesn't exist when it is given, with a suggestion for a close typo,
// rather than sending a request the workspace refuses and blaming the workspace (app !2138, round 6, L4).
func TestAgentScopesFlagRefusesUnknownScopes(t *testing.T) {
	for flag, want := range map[string]string{"agent:read": "did you mean agents:read?", "mcp:read": "mcp: scopes are for the MCP server"} {
		h := newHarness(t)
		r := h.run("", "auth", "login", "--workspace", ws, "--agent-scopes", flag)
		if r.code != 2 || !strings.Contains(r.errOut, want) {
			t.Errorf("--agent-scopes %s: exit %d %s", flag, r.code, r.errOut)
		}
		h.fake.with(func(f *fakeOAuth) {
			if len(f.refreshes) != 0 {
				t.Errorf("--agent-scopes %s: a refresh was sent", flag)
			}
		})
	}
}
