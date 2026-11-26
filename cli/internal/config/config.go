// Package config is the CLI's layered configuration (the CLI design, section 13). Highest first:
//
//  1. flags on the command (Override);
//  2. environment variables, CAITLYN_<KEY>;
//  3. the project file, .caitlyn.toml, found by walking up from the working directory;
//  4. the user file, ~/.caitlyn/config: the selected profile, then its top-level settings;
//  5. built-in defaults.
//
// Credentials and anything that changes where a credential is sent never come from the project file: a cloned
// repository must not be able to send your token somewhere of its choosing. So a project file may hold only:
// workspace (and only one a profile in your user file already names: it chooses among your own workspaces, never
// adds one), profile (and only one your user file has), output, color and theme, the command defaults (agent,
// version, knowledge_base, wait_timeout) and apply.paths. Nothing that widens what a credential may do (scopes,
// read_only, agent_scopes), changes where it goes (endpoint, auth, client_id), runs a program (pager, editor,
// browser) or publishes (apply.publish).
//
// Choosing the profile can't loosen anything either: when the project file chooses it (by profile or by workspace),
// read_only and agent_scopes are the stricter of that profile's and the one you'd have had without the project file
// (default_profile, or default).
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// Origin is the layer a value came from.
type Origin string

// The layers, highest first.
const (
	FromFlag    Origin = "flag"
	FromEnv     Origin = "env"
	FromProject Origin = "project"
	FromProfile Origin = "user"
	FromUser    Origin = "user"
	FromDefault Origin = "default"
)

// Value is one setting's effective value and where it came from.
type Value struct {
	Key string
	// Value is the setting as text; a list is comma-separated (List has the items).
	Value string
	List  []string
	Set   bool
	// Origin is its layer; Source names the file (with the profile's table) or the variable.
	Origin Origin
	Source string
}

// Key describes a setting.
type Key struct {
	Name    string
	Default string
	// Project: the project file may set it (13.5).
	Project bool
	// Profile: it is usually set per profile (it is read from the profile first, then the top level).
	Profile bool
	// List: a TOML array (agent_scopes, scopes, apply.paths).
	List bool
	// NoEnv: never read from the environment, not even a CAITLYN_<KEY> made up from the name. For what only the person
	// who signed in may change (agent_scopes) and what decides how credentials are kept or found.
	NoEnv bool
	Env   []string
	Doc   string
}

// Keys is every setting the CLI reads, in the order `config list` prints them.
var Keys = []Key{
	{Name: "workspace", Project: true, Profile: true, Env: []string{"CAITLYN_WORKSPACE"}, Doc: "The workspace's hostname"},
	{Name: "profile", Project: true, Env: []string{"CAITLYN_PROFILE"}, Doc: "The profile to use"},
	{Name: "output", Default: "auto", Project: true, Profile: true, Env: []string{"CAITLYN_OUTPUT"}, Doc: "auto, table, json, jsonl, yaml or text"},
	{Name: "agent_output", Default: "json", Profile: true, Env: []string{"CAITLYN_AGENT_OUTPUT"}, Doc: "The output when an AI agent runs the CLI: json, yaml, text or same"},
	{Name: "agent_scopes", NoEnv: true, Default: "read-only", Profile: true, List: true, Doc: "What an AI agent may do with this profile: read-only, full, none, or a list of scopes"},
	{Name: "color", Default: "auto", Project: true, Doc: "auto, always or never"},
	{Name: "theme", Default: "auto", Project: true, Env: []string{"CAITLYN_THEME"}, Doc: "auto, dark, light or mono"},
	{Name: "accessible_colors", Default: "false", Env: []string{"CAITLYN_ACCESSIBLE_COLORS"}, Doc: "The 16-colour palette only"},
	{Name: "accessible", Default: "false", Env: []string{"CAITLYN_ACCESSIBLE"}, Doc: "Accessible prompts"},
	{Name: "glyphs", Env: []string{"CAITLYN_GLYPHS"}, Doc: "unicode or ascii (from the locale when unset)"},
	{Name: "logo", Default: "true", Env: []string{"CAITLYN_LOGO"}, Doc: "The emblem on the welcome, sign-in and first-run screens"},
	{Name: "pager", Default: "less -FRX", Env: []string{"CAITLYN_PAGER", "PAGER"}, Doc: `The pager; "" turns paging off`},
	{Name: "paging", Default: "auto", Doc: "How lists continue on a terminal with no pager: auto, prompt or off"},
	{Name: "spinner", Default: "true", Doc: "Spinners and progress bars on a terminal"},
	{Name: "editor", Env: []string{"CAITLYN_EDITOR", "VISUAL", "EDITOR"}, Doc: "The editor for draft edit and config edit"},
	{Name: "browser", Env: []string{"CAITLYN_BROWSER", "BROWSER"}, Doc: "The browser for sign-in"},
	{Name: "update_notice", Default: "true", Doc: "true, prompt or false"},
	{Name: "update_channel", Default: "stable", Doc: "stable or beta"},
	{Name: "telemetry", Default: "false", Doc: "Usage data for Caitlyn: anonymous usage data sent to Caitlyn, off until you turn it on (caitlyn telemetry on writes true, off writes false). Not your own traces (traces.otlp_endpoint)"},
	{Name: "traces.otlp_endpoint", Env: []string{"OTEL_EXPORTER_OTLP_ENDPOINT"}, Doc: "Your own traces: the OTLP/HTTP collector to send OpenTelemetry traces of the CLI's calls to (off when unset). Unrelated to usage data for Caitlyn"},
	{Name: "agent", Project: true, Profile: true, Env: []string{"CAITLYN_AGENT_ID"}, Doc: "The default agent for commands that take one"},
	{Name: "version", Project: true, Profile: true, Env: []string{"CAITLYN_VERSION"}, Doc: "The default agent version"},
	{Name: "knowledge_base", Project: true, Profile: true, Env: []string{"CAITLYN_KNOWLEDGE_BASE"}, Doc: "The default knowledge base"},
	{Name: "wait_timeout", Project: true, Profile: true, Env: []string{"CAITLYN_WAIT_TIMEOUT"}, Doc: "A default --timeout for --wait"},
	{Name: "apply.paths", Project: true, List: true, Doc: "The files and folders apply reads"},
	{Name: "apply.publish", NoEnv: true, Doc: "apply publishes after writing drafts, for a person (never under an AI agent or in CI)"},
	{Name: "endpoint", Profile: true, Env: []string{"CAITLYN_ENDPOINT"}, Doc: "Send requests here instead of https://<workspace>/api"},
	{Name: "auth", Profile: true, Env: []string{"CAITLYN_AUTH"}, Doc: "oauth, token, client-credentials, workload-identity or aws-iam"},
	{Name: "client_id", Profile: true, Env: []string{"CAITLYN_CLIENT_ID"}, Doc: "The OAuth or API client ID"},
	{Name: "scopes", Profile: true, List: true, Env: []string{"CAITLYN_SCOPES"}, Doc: "The scopes sign-in asks for"},
	{Name: "read_only", Default: "false", Profile: true, Env: []string{"CAITLYN_READ_ONLY"}, Doc: "Refuse every command that writes"},
	{Name: "id_token_env", NoEnv: true, Profile: true, Doc: "The variable holding a workload identity token"},
	{Name: "id_token_source", NoEnv: true, Default: "auto", Profile: true, Doc: "Where a workload identity token comes from: auto, env, github or buildkite"},
	{Name: "insecure_storage", NoEnv: true, Default: "false", Profile: true, Doc: "Tokens in a file instead of the keychain"},
}

// secretKeys are refused wherever they appear: secrets never go in a file the CLI reads (13.2, 13.3).
var secretKeys = map[string]bool{"token": true, "client_secret": true, "refresh_token": true, "access_token": true, "secret": true, "password": true}

// KeyNamed returns a setting's description, or nil.
func KeyNamed(name string) *Key {
	for i := range Keys {
		if Keys[i].Name == name {
			return &Keys[i]
		}
	}
	return nil
}

// Options says where to look.
type Options struct {
	// Getenv reads the environment (the streams' environment, so tests set their own).
	Getenv func(string) string
	// Home is the home directory; Dir the user folder (default Home/.caitlyn, or CAITLYN_CONFIG_DIR).
	Home, Dir string
	// WorkDir is where the project file search starts.
	WorkDir string
	// ProjectFile names the project file explicitly; NoProjectFile ignores it.
	ProjectFile   string
	NoProjectFile bool
	// Profile is --profile.
	Profile string
}

// Config is the loaded configuration.
type Config struct {
	opts      Options
	user      map[string]any
	project   map[string]any
	overrides map[string]string
	// UserPath and ProjectPath are the files read ("" when there is no project file).
	UserPath, ProjectPath string
	profile               string
	// projectWorkspace is why the project file's workspace was refused, if it was: it names no profile's workspace.
	projectWorkspace error
	profileOrigin    Value
}

// Load reads the user file and the project file.
func Load(o Options) (*Config, error) {
	if o.Getenv == nil {
		o.Getenv = os.Getenv
	}
	if o.Home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("the home directory could not be found: %w", err)
		}
		o.Home = h
	}
	if o.Dir == "" {
		if d := o.Getenv("CAITLYN_CONFIG_DIR"); d != "" {
			o.Dir = d
		} else {
			o.Dir = filepath.Join(o.Home, ".caitlyn")
		}
	}
	if o.WorkDir == "" {
		o.WorkDir, _ = os.Getwd()
	}
	c := &Config{opts: o, overrides: map[string]string{}, UserPath: filepath.Join(o.Dir, "config")}
	var err error
	if c.user, err = readTOML(c.UserPath); err != nil {
		return nil, err
	}
	if err := checkSecrets(c.user, c.UserPath); err != nil {
		return nil, err
	}
	if err := checkAgentScopesIn(c.user, c.UserPath); err != nil {
		return nil, err
	}
	if !o.NoProjectFile {
		pf := o.ProjectFile
		if pf == "" {
			pf = o.Getenv("CAITLYN_PROJECT_FILE")
		}
		if pf == "" {
			pf = FindProjectFile(o.WorkDir, o.Home)
		}
		if pf != "" {
			c.ProjectPath = pf
			if c.project, err = readTOML(pf); err != nil {
				return nil, err
			}
			if err := checkProject(c.project, pf); err != nil {
				return nil, err
			}
		}
	}
	if ws := str(c.project["workspace"]); ws != "" && c.profileForWorkspace(ws) == "" {
		c.projectWorkspace = &FileError{Path: c.ProjectPath, Key: "workspace", Err: fmt.Errorf(
			"%s is not the workspace of any profile in your user file. A project file can only choose among your own workspaces, so a cloned repository can't send your credentials to a host of its choosing. Sign in to it once to add it (caitlyn auth login --workspace %s), or name it with --workspace or CAITLYN_WORKSPACE", ws, ws)}
	}
	c.selectProfile()
	if c.profileOrigin.Origin == FromProject && c.profileTable(c.profile) == nil {
		return nil, &FileError{Path: c.ProjectPath, Key: "profile", Err: fmt.Errorf(
			"%s is not a profile in your user file. A project file can only choose among your own profiles. Sign in to add it (caitlyn auth login --profile %s), or choose one with --profile or CAITLYN_PROFILE", c.profile, c.profile)}
	}
	return c, nil
}

// baseline is the profile the person gets without the project file: default_profile, or default.
func (c *Config) baseline() string {
	if p := str(c.user["default_profile"]); p != "" {
		return p
	}
	return "default"
}

// profileGet reads a key as one profile has it: its own table, then the user file's top level, then the default.
func (c *Config) profileGet(profile, key string) Value {
	if v, ok := lookup(c.profileTable(profile), key); ok {
		return mkAny(key, v, FromProfile, c.UserPath+" [profiles."+profile+"]")
	}
	if v, ok := lookup(c.user, key); ok {
		return mkAny(key, v, FromUser, c.UserPath)
	}
	k := KeyNamed(key)
	if k != nil && k.Default != "" {
		v := mk(key, k.Default, FromDefault, "")
		v.Set = false
		return v
	}
	return Value{Key: key, Origin: FromDefault}
}

// stricter applies the rule in the package comment to read_only and agent_scopes, when the project file chose a
// profile other than the baseline, or the profile chosen isn't in the user file.
func (c *Config) stricter(key string, chosen Value) Value {
	// Applies when the project file chose the profile, or when the chosen profile (--profile, CAITLYN_PROFILE) isn't
	// in the user file: a name with no table mustn't shed the safeguards the person's own profile has
	if (c.profileOrigin.Origin != FromProject && c.profileTable(c.profile) != nil) || strings.EqualFold(c.profile, c.baseline()) {
		return chosen
	}
	base := c.profileGet(c.baseline(), key)
	base.Source = strings.TrimSpace(base.Source + " (stricter than the profile " + c.ProjectPath + " chose)")
	switch key {
	case "read_only":
		if truthyValue(base.Value) && !truthyValue(chosen.Value) {
			return base
		}
	case "agent_scopes":
		list := func(v Value) []string {
			if len(v.List) > 0 {
				return v.List
			}
			if v.Value == "" {
				return []string{"read-only"}
			}
			return strings.Split(v.Value, ",")
		}
		merged := StricterAgentScopes(list(chosen), list(base))
		if strings.Join(merged, ",") != strings.Join(list(chosen), ",") {
			base.Value, base.List, base.Set = strings.Join(merged, ","), merged, true
			return base
		}
	}
	return chosen
}

func truthyValue(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// StricterAgentScopes is what both agent_scopes settings allow: none wins; full gives way to the other; read-only is
// api:read; otherwise each scope one side grants is kept where the other side covers it.
//
// Each side is first read as the server reads a grant (agent.Effective's withinCeiling): a list that names areas and
// a surface scope too means those areas up to the surface scope's tier, so agents:write api:write is agents:write.
// Each side is then either a surface scope alone or areas alone, which the scope-by-scope rule below judges right.
func StricterAgentScopes(a, b []string) []string {
	norm := func(l []string) []string {
		switch {
		case len(l) == 1 && l[0] == "read-only":
			return []string{"api:read"}
		}
		return withinCeiling(l)
	}
	is := func(l []string, preset string) bool { return len(l) == 1 && l[0] == preset }
	switch {
	case is(a, "none") || is(b, "none"):
		return []string{"none"}
	case is(a, "full"):
		return b
	case is(b, "full"):
		return a
	case is(a, "read-only") && is(b, "read-only"):
		return a
	}
	na, nb := norm(a), norm(b)
	seen := map[string]bool{}
	var out []string
	keep := func(s string) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, s := range na {
		for _, t := range nb {
			if scopeCovers(t, s) {
				keep(s)
			} else if scopeCovers(s, t) {
				keep(t)
			} else if m := meetScope(s, t); m != "" {
				keep(m) // api:read and agents:write meet at agents:read
			}
		}
	}
	if len(out) == 0 {
		return []string{"none"}
	}
	sort.Strings(out)
	return out
}

// meetScope is the widest scope both cover when one is the api: family and the other a single family, or "".
func meetScope(a, b string) string {
	tiers := map[string]int{"read": 1, "write": 2, "admin": 3}
	names := []string{"", "read", "write", "admin"}
	ai, bi := strings.LastIndexByte(a, ':'), strings.LastIndexByte(b, ':')
	if ai < 0 || bi < 0 {
		return ""
	}
	af, at, bf, bt := a[:ai], tiers[a[ai+1:]], b[:bi], tiers[b[bi+1:]]
	if at == 0 || bt == 0 {
		return ""
	}
	family := ""
	switch {
	case af == "api":
		family = bf
	case bf == "api":
		family = af
	default:
		return ""
	}
	return family + ":" + names[min(at, bt)]
}

// withinCeiling is agent.Effective's reading of a list, which config can't import: when the list names areas, its
// api: scope is a ceiling, so each area is capped at it and the surface scopes (api:, mcp:) are dropped.
func withinCeiling(l []string) []string {
	tiers := map[string]int{"read": 1, "write": 2, "admin": 3}
	names := []string{"", "read", "write", "admin"}
	split := func(s string) (string, int) {
		i := strings.LastIndexByte(s, ':')
		if i < 0 {
			return s, 0
		}
		return s[:i], tiers[s[i+1:]]
	}
	surface := func(f string) bool { return f == "api" || f == "mcp" }
	areas, ceiling := false, 0
	for _, s := range l {
		f, t := split(s)
		if t > 0 && !surface(f) {
			areas = true
		}
		if f == "api" && t > ceiling {
			ceiling = t
		}
	}
	if !areas {
		return l
	}
	var out []string
	for _, s := range l {
		f, t := split(s)
		switch {
		case t > 0 && surface(f):
			continue
		case t > 0 && ceiling > 0 && t > ceiling:
			s = f + ":" + names[ceiling]
		}
		out = append(out, s)
	}
	return out
}

// scopeCovers: tiers nest (admin covers write covers read), and the api: family covers every family at its tier.
// The same rule as agent.Covers, which config can't import. It is right only scope by scope: StricterAgentScopes
// reads each side through withinCeiling first, so a side is never areas and a surface scope together.
func scopeCovers(granted, needed string) bool {
	tiers := map[string]int{"read": 1, "write": 2, "admin": 3}
	split := func(s string) (string, string) {
		i := strings.LastIndexByte(s, ':')
		if i < 0 {
			return s, ""
		}
		return s[:i], s[i+1:]
	}
	gf, gt := split(granted)
	nf, nt := split(needed)
	if tiers[gt] == 0 || tiers[nt] == 0 {
		return granted == needed
	}
	if gf == "api" && !KnownScopeFamily(nf) {
		return false // api: covers api: and the known areas, never mcp: or a family that doesn't exist
	}
	if gf != "api" && gf != nf {
		return false
	}
	return tiers[gt] >= tiers[nt]
}

// ProjectWorkspaceError is why the project file's workspace isn't used, or nil.
func (c *Config) ProjectWorkspaceError() error { return c.projectWorkspace }

// Dir is the user folder (~/.caitlyn), where the CLI also keeps its caches, its queue of usage data for Caitlyn and
// its lock files.
func (c *Config) Dir() string { return c.opts.Dir }

// Getenv reads the environment the configuration was loaded with.
func (c *Config) Getenv(k string) string { return c.opts.Getenv(k) }

// Override sets a value from a flag: it outranks every other layer.
func (c *Config) Override(key, value string) {
	c.overrides[key] = value
	if key == "profile" {
		c.opts.Profile = value
		c.selectProfile()
	}
}

// FindProjectFile walks up from dir to the first .caitlyn.toml, stopping at the repository root (a directory with
// .git) or the home directory, whichever comes first, so a file in a parent folder never captures every repository
// below it (13.3).
func FindProjectFile(dir, home string) string {
	d := filepath.Clean(dir)
	for {
		f := filepath.Join(d, ".caitlyn.toml")
		if st, err := os.Stat(f); err == nil && !st.IsDir() {
			return f
		}
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return ""
		}
		if d == filepath.Clean(home) {
			return ""
		}
		parent := filepath.Dir(d)
		if parent == d {
			return ""
		}
		d = parent
	}
}

func readTOML(path string) (map[string]any, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s could not be read: %w", path, err)
	}
	out := map[string]any{}
	if err := toml.Unmarshal(b, &out); err != nil {
		return nil, &FileError{Path: path, Err: err}
	}
	return out, nil
}

// FileError is a configuration file that can't be used. The CLI exits 2 with it.
type FileError struct {
	Path string
	Key  string
	Err  error
}

func (e *FileError) Error() string {
	if e.Key != "" {
		return fmt.Sprintf("%s: %s: %v", e.Path, e.Key, e.Err)
	}
	return fmt.Sprintf("%s: %v", e.Path, e.Err)
}

func (e *FileError) Unwrap() error { return e.Err }

func checkSecrets(m map[string]any, path string) error {
	var walk func(prefix string, v map[string]any) error
	walk = func(prefix string, v map[string]any) error {
		for k, val := range v {
			if secretKeys[k] {
				return &FileError{Path: path, Key: prefix + k, Err: errors.New("secrets never go in a configuration file; sign in with caitlyn auth login, which keeps them in the keychain")}
			}
			if sub, ok := val.(map[string]any); ok {
				if err := walk(prefix+k+".", sub); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk("", m)
}

// checkProject refuses a project file that holds what it may never hold (13.3): secrets, anything that changes
// where a credential goes, and programs to run.
func checkProject(m map[string]any, path string) error {
	if err := checkSecrets(m, path); err != nil {
		return err
	}
	for k, v := range flatten(m) {
		_ = v
		key := KeyNamed(k)
		switch {
		case key == nil && strings.HasPrefix(k, "profiles."):
			return &FileError{Path: path, Key: k, Err: errors.New("profiles belong in your user file (~/.caitlyn/config), not in a project file")}
		case key == nil:
			return &FileError{Path: path, Key: k, Err: errors.New("not a setting a project file may hold")}
		case !key.Project:
			return &FileError{Path: path, Key: k, Err: fmt.Errorf("may only be set in your user file, because a project file must not choose %s", whyUserOnly(k))}
		}
	}
	return nil
}

func whyUserOnly(k string) string {
	switch k {
	case "endpoint", "auth", "client_id", "scopes", "read_only", "id_token_env", "id_token_source", "insecure_storage", "agent_scopes":
		return "what credential is used or where it is sent"
	case "pager", "editor", "browser":
		return "what runs on your machine"
	case "telemetry":
		return "whether usage data for Caitlyn is shared"
	case "traces.otlp_endpoint":
		return "where your own traces are sent"
	}
	return "your personal settings"
}

// flatten turns nested tables into dotted keys: {apply: {paths: [...]}} gives apply.paths.
func flatten(m map[string]any) map[string]any {
	out := map[string]any{}
	var walk func(prefix string, v map[string]any)
	walk = func(prefix string, v map[string]any) {
		for k, val := range v {
			if sub, ok := val.(map[string]any); ok {
				walk(prefix+k+".", sub)
				continue
			}
			out[prefix+k] = val
		}
	}
	walk("", m)
	return out
}

func (c *Config) selectProfile() {
	switch {
	case c.opts.Profile != "":
		c.profile, c.profileOrigin = c.opts.Profile, Value{Origin: FromFlag, Source: "--profile"}
	case c.opts.Getenv("CAITLYN_PROFILE") != "":
		c.profile, c.profileOrigin = c.opts.Getenv("CAITLYN_PROFILE"), Value{Origin: FromEnv, Source: "CAITLYN_PROFILE"}
	case str(c.project["profile"]) != "":
		c.profile, c.profileOrigin = str(c.project["profile"]), Value{Origin: FromProject, Source: c.ProjectPath}
	case str(c.project["workspace"]) != "" && c.profileForWorkspace(str(c.project["workspace"])) != "":
		c.profile = c.profileForWorkspace(str(c.project["workspace"]))
		c.profileOrigin = Value{Origin: FromProject, Source: c.ProjectPath + " (workspace)"}
	case str(c.user["default_profile"]) != "":
		c.profile, c.profileOrigin = str(c.user["default_profile"]), Value{Origin: FromUser, Source: c.UserPath + " (default_profile)"}
	default:
		c.profile, c.profileOrigin = "default", Value{Origin: FromDefault}
	}
}

func (c *Config) profileForWorkspace(ws string) string {
	for _, name := range c.Profiles() {
		if strings.EqualFold(str(c.profileTable(name)["workspace"]), ws) {
			return name
		}
	}
	return ""
}

// Profile is the selected profile's name.
func (c *Config) Profile() string { return c.profile }

// Profiles lists the profiles in the user file, sorted.
func (c *Config) Profiles() []string {
	t, _ := c.user["profiles"].(map[string]any)
	out := make([]string, 0, len(t))
	for k := range t {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// HasProfile reports whether the user file has the profile.
func (c *Config) HasProfile(name string) bool {
	t, _ := c.user["profiles"].(map[string]any)
	_, ok := t[name]
	return ok
}

func (c *Config) profileTable(name string) map[string]any {
	t, _ := c.user["profiles"].(map[string]any)
	p, _ := t[name].(map[string]any)
	return p
}

func lookup(m map[string]any, dotted string) (any, bool) {
	parts := strings.Split(dotted, ".")
	var cur any = m
	for _, p := range parts {
		t, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur, ok = t[p]
		if !ok {
			return nil, false
		}
	}
	return cur, true
}

// Get returns a setting's effective value.
func (c *Config) Get(key string) Value {
	if key == "profile" {
		v := c.profileOrigin
		v.Key, v.Value, v.Set = key, c.profile, true
		return v
	}
	if v, ok := c.overrides[key]; ok {
		return mk(key, v, FromFlag, "--"+strings.ReplaceAll(key, "_", "-"))
	}
	k := KeyNamed(key)
	envs := []string{"CAITLYN_" + strings.ToUpper(strings.NewReplacer(".", "_").Replace(key))}
	if k != nil && len(k.Env) > 0 {
		envs = k.Env
	}
	if k != nil && k.NoEnv {
		envs = nil
	}
	// CAITLYN_READ_ONLY only tightens: set to true it makes any profile read-only, but false never lifts a profile's
	// read_only = true
	if key == "read_only" {
		v := c.getNoEnv(key, k)
		if e := c.opts.Getenv("CAITLYN_READ_ONLY"); truthyValue(e) && !truthyValue(v.Value) {
			return mk(key, e, FromEnv, "CAITLYN_READ_ONLY")
		}
		return v
	}
	for _, e := range envs {
		if v := c.opts.Getenv(e); v != "" {
			return mk(key, v, FromEnv, e)
		}
	}
	return c.getNoEnv(key, k)
}

// getNoEnv is Get below the environment: the project file, the profile, the user file, the default.
func (c *Config) getNoEnv(key string, k *Key) Value {
	if (k == nil || k.Project) && !(key == "workspace" && c.projectWorkspace != nil) {
		if v, ok := lookup(c.project, key); ok {
			return mkAny(key, v, FromProject, c.ProjectPath)
		}
	}
	if key == "read_only" || key == "agent_scopes" {
		return c.stricter(key, c.profileGet(c.profile, key))
	}
	if v, ok := lookup(c.profileTable(c.profile), key); ok {
		return mkAny(key, v, FromProfile, c.UserPath+" [profiles."+c.profile+"]")
	}
	if v, ok := lookup(c.user, key); ok && key != "profiles" {
		return mkAny(key, v, FromUser, c.UserPath)
	}
	if k != nil && k.Default != "" {
		v := mk(key, k.Default, FromDefault, "")
		v.Set = false
		return v
	}
	return Value{Key: key, Origin: FromDefault}
}

// String is Get(key).Value.
func (c *Config) String(key string) string { return c.Get(key).Value }

// Bool reads a true/false setting.
func (c *Config) Bool(key string) bool {
	switch strings.ToLower(c.String(key)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// ProfileValue reads a setting from one profile's table only (for `auth status` and agent scopes).
func (c *Config) ProfileValue(profile, key string) (Value, bool) {
	v, ok := lookup(c.profileTable(profile), key)
	if !ok {
		return Value{}, false
	}
	return mkAny(key, v, FromProfile, c.UserPath+" [profiles."+profile+"]"), true
}

func mk(key, v string, o Origin, src string) Value {
	val := Value{Key: key, Value: v, Set: true, Origin: o, Source: src}
	if k := KeyNamed(key); k != nil && k.List {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				val.List = append(val.List, p)
			}
		}
	}
	return val
}

func mkAny(key string, v any, o Origin, src string) Value {
	switch t := v.(type) {
	case []any:
		items := make([]string, 0, len(t))
		for _, i := range t {
			items = append(items, fmt.Sprint(i))
		}
		return Value{Key: key, Value: strings.Join(items, ","), List: items, Set: true, Origin: o, Source: src}
	default:
		return mk(key, fmt.Sprint(v), o, src)
	}
}

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

// All lists every known setting's effective value, in Keys order.
func (c *Config) All() []Value {
	out := make([]Value, 0, len(Keys))
	for _, k := range Keys {
		out = append(out, c.Get(k.Name))
	}
	return out
}
