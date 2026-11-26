// Package auth is the CLI's sign-in (the CLI design, sections 5, 15.3 and 18.5): the provider every command's clients
// sign in through, the token store (the keychain, or an opt-in file, behind a per-profile file lock), browser and
// device sign-in, workload identity in CI, AI agents' narrower tokens, and the `auth` commands.
package auth

import (
	"context"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/go/core"
)

// The sign-in modes, as the auth setting and CAITLYN_AUTH spell them.
const (
	ModeOAuth             = "oauth"
	ModeToken             = "token"
	ModeClientCredentials = "client-credentials"
	ModeWorkloadIdentity  = "workload-identity"
	ModeAWSIAM            = "aws-iam"
)

// Modes lists them.
var Modes = []string{ModeOAuth, ModeToken, ModeClientCredentials, ModeWorkloadIdentity, ModeAWSIAM}

// Provider implements cmdutil.AuthProvider. The root command makes one per run.
type Provider struct {
	mu   sync.Mutex
	last *session
}

// NewProvider returns the sign-in provider.
func NewProvider() *Provider { return &Provider{} }

var _ cmdutil.AuthProvider = (*Provider)(nil)

// session is the OAuth session the last Auth call made, if any (auth status and auth token read it).
func (p *Provider) session() *session {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.last
}

// Auth signs in for a command. The mode comes from flags, then the environment, then the profile's auth (5.1).
func (p *Provider) Auth(ctx context.Context, f *cmdutil.Factory, req cmdutil.AuthRequest) (core.Auth, *cmdutil.AuthInfo, error) {
	cfg, err := f.Config()
	if err != nil {
		return nil, nil, err
	}
	ws := core.WorkspaceHost(req.Workspace)
	profile := req.Profile
	if profile == "" {
		profile = cfg.Profile()
	}
	mode, err := resolveMode(f.IO.Getenv, cfg)
	if err != nil {
		return nil, nil, err
	}
	readOnly := cfg.Bool("read_only") || truthy(f.IO.Getenv("CAITLYN_READ_ONLY"))
	var setting []string
	if req.Agent {
		setting = AgentSetting(cfg)
		if len(setting) == 1 && setting[0] == agent.None {
			return nil, nil, agentRefused(profile)
		}
	}
	getenv := f.IO.Getenv
	hc := httpClient(f)
	var (
		a    core.Auth
		info = &cmdutil.AuthInfo{Mode: mode}
	)
	switch mode {
	case ModeToken:
		if tok := strings.TrimSpace(getenv("CAITLYN_TOKEN")); tok != "" {
			a, info.Storage = core.Token(tok), "the environment (CAITLYN_TOKEN)"
			break
		}
		st := storeFor(f, cfg, ws, profile)
		e, err := st.Load(st.PersonKey())
		if err != nil {
			return nil, nil, err
		}
		if e == nil || e.Kind != "token" {
			return nil, nil, signInRequired(st, "Not signed in.")
		}
		a, info.Storage = core.Token(e.AccessToken), st.StorageName()
	case ModeClientCredentials:
		id, secret := cfg.String("client_id"), getenv("CAITLYN_CLIENT_SECRET")
		if id == "" || secret == "" {
			e := cmdutil.Usagef("Client credentials need both CAITLYN_CLIENT_ID and CAITLYN_CLIENT_SECRET.")
			e.Detail = "Set both, or sign in another way. The secret is only ever read from the environment."
			return nil, nil, e
		}
		cc := core.ClientCredentials{ClientID: id, ClientSecret: secret, Scopes: cfg.Get("scopes").List}
		a, info.Storage, info.Scopes = cc, "the environment (CAITLYN_CLIENT_ID, CAITLYN_CLIENT_SECRET)", cc.Scopes
	case ModeWorkloadIdentity:
		fn, from, err := idTokenSource(cfg.String("id_token_source"), cfg.String("id_token_env"), core.WorkspaceAudience(ws), getenv, hc)
		if err != nil {
			return nil, nil, err
		}
		a, info.Storage = core.WorkloadIdentity{Token: fn}, "none: a fresh identity token from "+from+" at each sign-in"
	case ModeAWSIAM:
		// The SDK reads the AWS_* variables or the container credentials endpoint itself
		a, info.Storage = core.AWSIAM{}, "none: AWS credentials at each sign-in"
	case ModeOAuth:
		st := storeFor(f, cfg, ws, profile)
		person, err := st.Load(st.PersonKey())
		if err != nil {
			return nil, nil, err
		}
		if person == nil {
			return nil, nil, signInRequired(st, "Not signed in.")
		}
		info.Storage = st.StorageName()
		if st.Insecure() {
			info.Storage += " (insecure storage: a file, not the keychain)"
		}
		info.Scopes = person.Scopes()
		if person.Kind == "token" {
			// A personal access token saved with --with-token: it can't be narrowed, so agent scopes are the CLI's alone
			a, info.Mode = core.Token(person.AccessToken), ModeToken
			break
		}
		s := &session{store: st, oc: newOAuthClient(ws, req.Endpoint, hc, userAgent(f), f.Now), now: nowFunc(f), info: info}
		if req.Agent {
			eff := agent.Effective(setting, person.Scopes(), readOnly)
			if len(eff) == 0 {
				e := agentRefused(profile)
				e.Title = "This profile's agent scopes leave nothing its sign-in was granted."
				e.Detail = "agent_scopes is " + agent.Describe(setting) + "; the sign-in holds " + person.Scope + "."
				return nil, nil, e
			}
			s.agentScopes, s.agentKey = eff, agent.CacheKey(ws, profile, eff)
		}
		p.mu.Lock()
		p.last = s
		p.mu.Unlock()
		a = core.TokenFunc(s.Token)
	}
	if req.Agent {
		if s := p.session(); s != nil && s.agentScopes != nil && mode == ModeOAuth && info.Mode == ModeOAuth {
			info.AgentScopes = s.agentScopes
		} else {
			// Not narrowed by the server in these modes: the CLI's pre-check is the only enforcement
			info.AgentScopes = agent.Effective(setting, info.Scopes, readOnly)
		}
	}
	return a, info, nil
}

// resolveMode picks the sign-in mode: an explicit auth (a flag or CAITLYN_AUTH), then the credential in the
// environment, then the profile's auth, then oauth. Two credentials at once are a usage error, never a silent choice.
func resolveMode(getenv func(string) string, cfg *config.Config) (string, error) {
	var creds []string
	credMode := map[string]string{}
	add := func(v, mode string) {
		creds = append(creds, v)
		credMode[v] = mode
	}
	if getenv("CAITLYN_TOKEN") != "" {
		add("CAITLYN_TOKEN", ModeToken)
	}
	switch {
	case getenv("CAITLYN_CLIENT_ID") != "":
		add("CAITLYN_CLIENT_ID", ModeClientCredentials)
	case getenv("CAITLYN_CLIENT_SECRET") != "":
		add("CAITLYN_CLIENT_SECRET", ModeClientCredentials)
	}
	if getenv("CAITLYN_ID_TOKEN") != "" {
		add("CAITLYN_ID_TOKEN", ModeWorkloadIdentity)
	}
	if len(creds) > 1 {
		e := cmdutil.Usagef("%s are all set: give one credential.", strings.Join(creds, " and "))
		if len(creds) == 2 {
			e.Title = strings.Join(creds, " and ") + " are both set: give one credential."
		}
		e.Code = "TWO_CREDENTIALS"
		e.Detail = "The CLI never chooses between credentials for you. Unset the ones you don't mean to use."
		return "", e
	}
	v := cfg.Get("auth")
	if v.Value != "" {
		mode, err := normaliseMode(v.Value, v.Source)
		if err != nil {
			return "", err
		}
		explicit := v.Origin == config.FromFlag || v.Origin == config.FromEnv
		if explicit && len(creds) == 1 && credMode[creds[0]] != mode {
			e := cmdutil.Usagef("%s=%s, but %s is set too: give one credential.", v.Source, v.Value, creds[0])
			e.Code = "TWO_CREDENTIALS"
			return "", e
		}
		if explicit || len(creds) == 0 {
			return mode, nil
		}
	}
	if len(creds) == 1 {
		return credMode[creds[0]], nil
	}
	return ModeOAuth, nil
}

func normaliseMode(v, source string) (string, error) {
	m := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(v)), "_", "-")
	switch m {
	case "clientcredentials":
		m = ModeClientCredentials
	case "workloadidentity":
		m = ModeWorkloadIdentity
	case "awsiam":
		m = ModeAWSIAM
	}
	for _, ok := range Modes {
		if m == ok {
			return m, nil
		}
	}
	e := cmdutil.Usagef("%q is not a sign-in mode: use %s.", v, strings.Join(Modes, ", "))
	if source != "" {
		e.Detail = "It comes from " + source + "."
	}
	return "", e
}

// AgentSetting reads the profile's agent_scopes: a preset or a list (read-only when unset).
func AgentSetting(cfg *config.Config) []string {
	v := cfg.Get("agent_scopes")
	if len(v.List) > 0 {
		return v.List
	}
	if v.Value != "" {
		return []string{v.Value}
	}
	return []string{agent.ReadOnly}
}

func agentRefused(profile string) *cmdutil.Error {
	e := cmdutil.Forbiddenf("AGENT_NOT_ALLOWED", "AI agents may not use this profile.")
	e.Detail = "The person who signed in set this profile's agent scopes to none."
	e.AddNext("caitlyn config set agent_scopes read-only --profile "+profile, "the person can allow agents to read (only a person can change this)")
	return e
}

// storeFor opens the profile's token store.
func storeFor(f *cmdutil.Factory, cfg *config.Config, ws, profile string) *Store {
	return newStore(cfg.Dir(), homeDir(f), ws, profile, cfg.Bool("insecure_storage"))
}

func homeDir(f *cmdutil.Factory) string {
	if f.Home != "" {
		return f.Home
	}
	h, _ := os.UserHomeDir()
	return h
}

func httpClient(f *cmdutil.Factory) *http.Client {
	if f.HTTPClient != nil {
		return f.HTTPClient
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func userAgent(f *cmdutil.Factory) string {
	return "caitlyn-cli/" + f.Version + " (" + f.UserAgentSuffix() + ")"
}

func nowFunc(f *cmdutil.Factory) func() time.Time {
	if f.Now != nil {
		return f.Now
	}
	return time.Now
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
