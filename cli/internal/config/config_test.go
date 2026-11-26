package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type env map[string]string

func (e env) get(k string) string { return e[k] }

func setup(t *testing.T, user, project string, e env) (*Config, string) {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, ".caitlyn")
	repo := filepath.Join(home, "src", "repo")
	work := filepath.Join(repo, "sub")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if user != "" {
		os.MkdirAll(dir, 0o700)
		os.WriteFile(filepath.Join(dir, "config"), []byte(user), 0o600)
	}
	if project != "" {
		os.WriteFile(filepath.Join(repo, ".caitlyn.toml"), []byte(project), 0o644)
	}
	if e == nil {
		e = env{}
	}
	c, err := Load(Options{Getenv: e.get, Home: home, Dir: dir, WorkDir: work})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return c, repo
}

const userFile = `default_profile = "default"
output = "yaml"
pager = "less -FRX"

[profiles.default]
workspace = "your-company.caitlyn.ai"
output = "json"
agent_scopes = "read-only"

[profiles.staging]
workspace = "staging.caitlyn.ai"
read_only = true
`

// TestPrecedence is the table test of every layer against a key: flag, env, project, profile, user, default (13.1).
func TestPrecedence(t *testing.T) {
	cases := []struct {
		name, project string
		env           env
		flag          string
		want          string
		origin        Origin
	}{
		{name: "default", want: "auto", origin: FromDefault},
		{name: "profile over user top level", want: "json", origin: FromProfile},
		{name: "project over profile", project: `output = "table"`, want: "table", origin: FromProject},
		{name: "env over project", project: `output = "table"`, env: env{"CAITLYN_OUTPUT": "jsonl"}, want: "jsonl", origin: FromEnv},
		{name: "flag over env", project: `output = "table"`, env: env{"CAITLYN_OUTPUT": "jsonl"}, flag: "text", want: "text", origin: FromFlag},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			user := userFile
			if tc.name == "default" {
				user = ""
			}
			c, _ := setup(t, user, tc.project, tc.env)
			if tc.flag != "" {
				c.Override("output", tc.flag)
			}
			v := c.Get("output")
			if v.Value != tc.want || v.Origin != tc.origin {
				t.Fatalf("got %q from %s, want %q from %s", v.Value, v.Origin, tc.want, tc.origin)
			}
		})
	}
}

func TestEveryKeyResolvesFromEachLayer(t *testing.T) {
	for _, k := range Keys {
		if k.List || strings.Contains(k.Name, ".") {
			continue
		}
		t.Run(k.Name, func(t *testing.T) {
			envName := "CAITLYN_" + strings.ToUpper(k.Name)
			if len(k.Env) > 0 {
				envName = k.Env[0]
			}
			c, _ := setup(t, "[profiles.default]\n"+k.Name+" = \"from-profile\"\n", "", env{envName: "from-env"})
			if k.Name == "profile" {
				return
			}
			switch {
			case k.NoEnv:
				if v := c.Get(k.Name); v.Origin == FromEnv {
					t.Fatalf("%s is never read from the environment, got %q from %s", k.Name, v.Value, v.Source)
				}
			case k.Name == "read_only":
				// only tightens: tested in TestReadOnlyEnvOnlyTightens
			default:
				if v := c.Get(k.Name); v.Value != "from-env" || v.Origin != FromEnv {
					t.Fatalf("env: got %q from %s", v.Value, v.Origin)
				}
			}
			c, _ = setup(t, "[profiles.default]\n"+k.Name+" = \"from-profile\"\n", "", nil)
			if v := c.Get(k.Name); v.Value != "from-profile" {
				t.Fatalf("profile: got %q from %s", v.Value, v.Origin)
			}
		})
	}
}

func TestProfileSelection(t *testing.T) {
	c, _ := setup(t, userFile, "", env{"CAITLYN_PROFILE": "staging"})
	if c.Profile() != "staging" || c.String("workspace") != "staging.caitlyn.ai" || !c.Bool("read_only") {
		t.Fatalf("CAITLYN_PROFILE: %s %s", c.Profile(), c.String("workspace"))
	}
	c, _ = setup(t, userFile, `workspace = "staging.caitlyn.ai"`, nil)
	if c.Profile() != "staging" {
		t.Fatalf("project workspace should pick the profile with it, got %s", c.Profile())
	}
	c, _ = setup(t, userFile, `profile = "staging"`, nil)
	c.Override("profile", "default")
	if c.Profile() != "default" {
		t.Fatalf("--profile wins, got %s", c.Profile())
	}
}

func TestProjectFileMayNotHold(t *testing.T) {
	for _, bad := range []string{
		`endpoint = "https://evil.example/api"`, `auth = "token"`, `client_id = "x"`, `scopes = ["api:admin"]`,
		`read_only = false`, `agent_scopes = "full"`, `pager = "sh -c evil"`, `editor = "evil"`, `browser = "evil"`,
		`telemetry = true`, `token = "cait-pat-x"`, `[profiles.default]` + "\nworkspace = \"x\"", `nonsense = 1`,
	} {
		home := t.TempDir()
		repo := filepath.Join(home, "repo")
		os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
		os.WriteFile(filepath.Join(repo, ".caitlyn.toml"), []byte(bad), 0o644)
		_, err := Load(Options{Getenv: env{}.get, Home: home, WorkDir: repo})
		var fe *FileError
		if err == nil || !asFileError(err, &fe) {
			t.Errorf("%s: want a FileError, got %v", bad, err)
		}
	}
}

func asFileError(err error, fe **FileError) bool {
	e, ok := err.(*FileError)
	*fe = e
	return ok
}

func TestUserFileRefusesSecrets(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".caitlyn")
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "config"), []byte("[profiles.default]\nclient_secret = \"x\"\n"), 0o600)
	if _, err := Load(Options{Getenv: env{}.get, Home: home, Dir: dir, WorkDir: home}); err == nil {
		t.Fatal("a client secret in the user file must be refused")
	}
}

// TestProjectSearchStopsAtRepositoryRoot: a .caitlyn.toml above the repository root is never read (13.3).
func TestProjectSearchStopsAtRepositoryRoot(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, ".caitlyn.toml"), []byte(`output = "yaml"`), 0o644)
	repo := filepath.Join(home, "repo")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
	if got := FindProjectFile(repo, "/nonexistent"); got != "" {
		t.Fatalf("found %s above the repository root", got)
	}
	os.WriteFile(filepath.Join(repo, ".caitlyn.toml"), []byte(`output = "yaml"`), 0o644)
	if got := FindProjectFile(filepath.Join(repo), home); got != filepath.Join(repo, ".caitlyn.toml") {
		t.Fatalf("got %q", got)
	}
}

// TestSetKeepsComments: config set edits one line, keeping the file's comments and layout.
func TestSetKeepsComments(t *testing.T) {
	c, _ := setup(t, "# my settings\noutput = \"yaml\" # keep\n\n[profiles.default]\n# the main one\nworkspace = \"a.example\"\n", "", nil)
	if err := c.Set("output", "json", "", false); err != nil {
		t.Fatal(err)
	}
	if err := c.Set("agent_scopes", "agents:read,knowledge-bases:read", "default", false); err != nil {
		t.Fatal(err)
	}
	if err := c.Set("workspace", "b.example", "new", false); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(c.UserPath)
	got := string(b)
	for _, want := range []string{"# my settings", "output = \"json\"", "# the main one", `agent_scopes = ["agents:read", "knowledge-bases:read"]`, "[profiles.new]\nworkspace = \"b.example\""} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
	c2, err := Load(Options{Getenv: env{}.get, Home: filepath.Dir(filepath.Dir(c.UserPath)), Dir: filepath.Dir(c.UserPath), WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if v := c2.Get("agent_scopes"); len(v.List) != 2 {
		t.Fatalf("agent_scopes: %+v", v)
	}
	if err := c2.Unset("output", "", false); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(c.UserPath)
	if strings.Contains(string(b), "output =") {
		t.Fatalf("unset left the key:\n%s", b)
	}
}

func TestSetRefusesUserOnlyKeysInProject(t *testing.T) {
	c, _ := setup(t, userFile, `workspace = "x.example"`, nil)
	if err := c.Set("endpoint", "https://x", "", true); err == nil {
		t.Fatal("endpoint must not be written to a project file")
	}
	if err := c.Set("knowledge_base", "KB1", "", true); err != nil {
		t.Fatal(err)
	}
}

func TestReadOnlyEnvOnlyTightens(t *testing.T) {
	user := "[profiles.default]\nread_only = true\n"
	for _, v := range []string{"false", "0", "no"} {
		c, _ := setup(t, user, "", env{"CAITLYN_READ_ONLY": v})
		if !c.Bool("read_only") {
			t.Errorf("CAITLYN_READ_ONLY=%s lifted read_only", v)
		}
	}
	c, _ := setup(t, "[profiles.default]\nworkspace = \"a.caitlyn.ai\"\n", "", env{"CAITLYN_READ_ONLY": "1"})
	if !c.Bool("read_only") {
		t.Error("CAITLYN_READ_ONLY=1 doesn't make the profile read-only")
	}
}

// A repository can't use a link to make config set write outside it (round 3, M4).
func TestConfigWritesNeverFollowLinks(t *testing.T) {
	c, repo := setup(t, userFile, "output = \"json\"\n", nil)
	victim := filepath.Join(t.TempDir(), "victim")
	os.WriteFile(victim, []byte("keep me\n"), 0o600)
	// the old fixed temporary name, planted as a link
	if err := os.Symlink(victim, filepath.Join(repo, ".caitlyn.toml.tmp")); err != nil {
		t.Fatal(err)
	}
	if err := c.Set("knowledge_base", "KB4T7YQ2WL", "", true); err != nil {
		t.Fatalf("set: %v", err)
	}
	if b, _ := os.ReadFile(victim); string(b) != "keep me\n" {
		t.Fatalf("the link's target was written: %q", b)
	}
	if fi, _ := os.Lstat(filepath.Join(repo, ".caitlyn.toml")); fi.Mode()&os.ModeSymlink != 0 {
		t.Fatal(".caitlyn.toml became a link")
	}
	// a project file that is itself a link is refused
	os.Remove(filepath.Join(repo, ".caitlyn.toml"))
	os.Symlink(victim, filepath.Join(repo, ".caitlyn.toml"))
	c, _ = setup(t, userFile, "", nil)
	c.ProjectPath = filepath.Join(repo, ".caitlyn.toml")
	if err := c.Set("knowledge_base", "KB4T7YQ2WL", "", true); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("a linked project file: %v", err)
	}
	if b, _ := os.ReadFile(victim); string(b) != "keep me\n" {
		t.Fatalf("the link's target was written: %q", b)
	}
}

// Concurrent writers don't lose each other's changes (round 3, M4).
func TestConcurrentConfigWrites(t *testing.T) {
	c, _ := setup(t, userFile, "", nil)
	done := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func(i int) {
			done <- c.Set("agent", fmt.Sprintf("AGENT%05d", i), fmt.Sprintf("p%d", i), false)
		}(i)
	}
	for i := 0; i < 8; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	b, _ := os.ReadFile(c.UserPath)
	for i := 0; i < 8; i++ {
		if !strings.Contains(string(b), fmt.Sprintf("AGENT%05d", i)) {
			t.Fatalf("profile p%d's change was lost:\n%s", i, b)
		}
	}
}

// Your own user file may be a link (stow, chezmoi, home-manager): the file it points to is edited (round 4, L4).
func TestLinkedUserFileIsEdited(t *testing.T) {
	c, _ := setup(t, userFile, "", nil)
	real := filepath.Join(t.TempDir(), "dotfiles-config")
	b, _ := os.ReadFile(c.UserPath)
	os.WriteFile(real, b, 0o600)
	os.Remove(c.UserPath)
	if err := os.Symlink(real, c.UserPath); err != nil {
		t.Fatal(err)
	}
	if err := c.Set("output", "table", "", false); err != nil {
		t.Fatalf("set through a linked user file: %v", err)
	}
	if fi, _ := os.Lstat(c.UserPath); fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link was replaced by a file")
	}
	if b, _ := os.ReadFile(real); !strings.Contains(string(b), `output = "table"`) {
		t.Fatalf("the target wasn't edited:\n%s", b)
	}
}

// Each side is read as the server reads a grant: a list naming an area and a surface scope means that area up to the
// surface scope's tier, so a locked read-only never meets it as every area (round 9, M1 and L4).
func TestStricterAgentScopesReadsEachSideAsAWhole(t *testing.T) {
	for _, c := range []struct{ a, b, want []string }{
		{[]string{"read-only"}, []string{"agents:write", "api:write"}, []string{"agents:read"}},
		{[]string{"read-only"}, []string{"agents:write", "knowledge-bases:read"}, []string{"agents:read", "knowledge-bases:read"}},
		{[]string{"agents:write", "api:read"}, []string{"full"}, []string{"agents:write", "api:read"}},
		{[]string{"agents:write", "api:read"}, []string{"agents:write", "users:write"}, []string{"agents:read"}},
		{[]string{"read-only"}, []string{"api:write"}, []string{"api:read"}},
		{[]string{"none"}, []string{"agents:read"}, []string{"none"}},
	} {
		if got := StricterAgentScopes(c.a, c.b); strings.Join(got, " ") != strings.Join(c.want, " ") {
			t.Errorf("StricterAgentScopes(%v, %v) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// agent_scopes takes the presets, or api: and the known areas at a tier; never mcp:, and never a family that
// doesn't exist. A close typo gets a suggestion (app !2138, round 6, L4).
func TestCheckAgentScopes(t *testing.T) {
	for _, ok := range [][]string{{"read-only"}, {"full"}, {"none"}, {"api:read"}, {"agents:read", "knowledge-bases:write"}, {"users:admin"}} {
		if err := CheckAgentScopes(ok); err != nil {
			t.Errorf("%v: %v", ok, err)
		}
	}
	for _, c := range []struct {
		list []string
		want string
	}{
		{[]string{"agent:read"}, "did you mean agents:read?"},
		{[]string{"mcp:read"}, "mcp: scopes are for the MCP server"},
		{[]string{"agents:edit"}, "did you mean agents:read?"},
		{[]string{"knowledge-base:write"}, "did you mean knowledge-bases:write?"},
		{[]string{"nonsense:read"}, "is not a scope an agent can have"},
		{[]string{"read-only", "agents:read"}, "on its own"},
	} {
		err := CheckAgentScopes(c.list)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v, want %q", c.list, err, c.want)
		}
		if err != nil && !strings.Contains(err.Error(), "read-only") && c.want != "on its own" {
			t.Errorf("%v: the error doesn't list what's valid: %v", c.list, err)
		}
	}
}

// A bad agent_scopes in the user file, at the top or in a profile, is refused when the configuration is read, with
// the file and key named; config set refuses one before writing it.
func TestBadAgentScopesRefused(t *testing.T) {
	for _, file := range []string{
		"agent_scopes = [\"agent:read\"]\n",
		"[profiles.default]\nagent_scopes = [\"mcp:read\"]\n",
	} {
		home := t.TempDir()
		dir := filepath.Join(home, ".caitlyn")
		os.MkdirAll(dir, 0o700)
		os.WriteFile(filepath.Join(dir, "config"), []byte(file), 0o600)
		_, err := Load(Options{Home: home, Getenv: func(string) string { return "" }, WorkDir: t.TempDir()})
		var fe *FileError
		if !errors.As(err, &fe) || !strings.Contains(fe.Key, "agent_scopes") {
			t.Errorf("%q: %v, want a FileError on agent_scopes", file, err)
		}
	}
	home := t.TempDir()
	c, err := Load(Options{Home: home, Getenv: func(string) string { return "" }, WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Set("agent_scopes", "agent:read", "default", false); err == nil || !strings.Contains(err.Error(), "did you mean agents:read?") {
		t.Errorf("config set agent_scopes agent:read: %v", err)
	}
	if scopeCovers("api:admin", "mcp:read") || scopeCovers("api:admin", "agent:read") {
		t.Error("scopeCovers lets api: cover mcp: or an unknown family")
	}
}
