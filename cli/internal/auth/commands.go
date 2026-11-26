package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci/cisession"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
	caitlyn "github.com/caitlyn-ai/sdk/go"
	"github.com/caitlyn-ai/sdk/go/core"
)

// AddCommands adds `auth` and its top-level alias `login` to the root command.
func AddCommands(root *cobra.Command, f *cmdutil.Factory) {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Sign in, sign out, and see who you're signed in as",
		Long: `Sign in to Caitlyn workspaces, and manage the profiles that hold them.

Each profile is a workspace and its settings, in ~/.caitlyn/config; tokens are kept in your keychain. In CI, sign in
with environment variables instead: https://build.caitlyn.ai/cli/ci/#signing-in-without-secrets`,
		Args: cobra.NoArgs,
	}
	cmd.AddCommand(newLoginCmd(f, "login"), newLogoutCmd(f), newStatusCmd(f), newTokenCmd(f), newSwitchCmd(f))
	root.AddCommand(cmd)
	login := newLoginCmd(f, "login")
	login.Short = "Sign in to a workspace (the same as auth login)"
	root.AddCommand(login)
}

func newLogoutCmd(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Sign out: revoke the refresh token and remove the stored tokens",
		Long: `Sign out of the profile's workspace: the refresh token is revoked at the workspace, and the profile's tokens,
and any AI agent's token made from them, are removed from the keychain (or the credentials file).

The profile's settings stay in ~/.caitlyn/config. A personal access token is removed but not revoked: revoke it in
Caitlyn.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return runLogout(cmd.Context(), f) },
	}
}

func runLogout(ctx context.Context, f *cmdutil.Factory) error {
	cfg, err := f.Config()
	if err != nil {
		return err
	}
	wsv, err := f.Workspace()
	if err != nil {
		return err
	}
	ws, profile := core.WorkspaceHost(wsv), cfg.Profile()
	st := storeFor(f, cfg, ws, profile)
	oc := newOAuthClient(ws, cfg.String("endpoint"), httpClient(f), userAgent(f), nowFunc(f))
	var (
		found     *Entry
		revokeErr error
	)
	err = st.WithLock(ctx, func(ctx context.Context) error {
		e, err := st.Load(st.PersonKey())
		if err != nil || e == nil {
			return err
		}
		found = e
		if e.RefreshToken != "" {
			revokeErr = oc.revoke(ctx, e.RefreshToken)
		}
		if e.AgentKey != "" {
			if err := st.Delete(e.AgentKey); err != nil {
				return err
			}
		}
		return st.Delete(st.PersonKey())
	})
	if err != nil {
		return err
	}
	forgetIdentity(cfg.Dir(), profile)
	u := gen.UIFor(f)
	if found == nil {
		u.Infof("Not signed in to %s (profile %s): there was nothing to remove.", ws, profile)
		return nil
	}
	u.Successf("Signed out of %s (profile %s)", ws, profile)
	switch {
	case found.Kind == "token":
		u.Infof("  The personal access token was removed from %s. It works until it expires or you revoke it in Caitlyn.", st.StorageName())
	case found.RefreshToken == "":
		u.Infof("  The tokens were removed from %s.", st.StorageName())
	case revokeErr != nil:
		u.Warnf("The workspace couldn't revoke the refresh token (%s). It was removed from %s and expires on its own.", cmdutil.FromError(revokeErr).Title, st.StorageName())
	default:
		u.Infof("  The refresh token was revoked, and the tokens were removed from %s.", st.StorageName())
	}
	return nil
}

func newTokenCmd(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "token",
		Short: "Print the access token, for one-off use with curl",
		Long: `Print the profile's current access token on stdout, refreshing it first if it is due.

Warning: this is a bearer credential. Anyone who has it can act as you in the workspace until it expires. Don't
paste it into chats, issues, prompts or logs, and don't save it in a file. AI agents are refused it.`,
		Example: `  curl -H "Authorization: Bearer $(caitlyn auth token)" https://your-company.caitlyn.ai/api/v3/me`,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if f.Agent.On {
				e := cmdutil.Forbiddenf("SECRET_REFUSED_TO_AGENT", "auth token is refused to AI agents: it prints a bearer credential.")
				e.Detail = "Agents can't copy a token into a file, a log or a prompt. Run the caitlyn command that does the job instead."
				e.AddNext("caitlyn commands --output json", "find the command that does what the token was for")
				return e
			}
			tok, err := currentToken(cmd.Context(), f)
			if err != nil {
				return err
			}
			// A bearer token is a secret: in CI it needs --show-secret, and is masked first where the provider can (15.2)
			if err := cisession.For(f).Secret(tok); err != nil {
				return err
			}
			fmt.Fprintln(f.IO.Out, tok)
			return nil
		},
	}
}

// currentToken signs in as any command does and returns the bearer token the next request would send.
func currentToken(ctx context.Context, f *cmdutil.Factory) (string, error) {
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return "", err
	}
	if p, ok := f.Auth.(*Provider); ok {
		if s := p.session(); s != nil {
			return s.Token(ctx)
		}
	}
	return cc.Auth().Token(ctx)
}

func newSwitchCmd(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "switch <profile>",
		Short: "Make a profile the default",
		Long: `Make a profile the one used when no --profile, CAITLYN_PROFILE or project file chooses another. It sets
default_profile in ~/.caitlyn/config.`,
		Example: "  caitlyn auth switch staging",
		Args:    cobra.ExactArgs(1),
		ValidArgsFunction: func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
			cfg, err := f.Config()
			if err != nil {
				return nil, cobra.ShellCompDirectiveError
			}
			return cfg.Profiles(), cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if f.Agent.On {
				return cmdutil.Forbiddenf("AGENT_NOT_ALLOWED", "Only a person can change the default profile.")
			}
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			name := args[0]
			if !cfg.HasProfile(name) {
				e := cmdutil.Usagef("There's no profile called %s.", name)
				if ps := cfg.Profiles(); len(ps) > 0 {
					e.Detail = "The profiles are: " + strings.Join(ps, ", ") + "."
				}
				e.AddNext("caitlyn auth login --profile "+name+" --workspace your-company.caitlyn.ai", "sign in to create it")
				return e
			}
			if err := cfg.Set("default_profile", name, "", false); err != nil {
				return err
			}
			ws, _ := cfg.ProfileValue(name, "workspace")
			u := gen.UIFor(f)
			if ws.Value != "" {
				u.Successf("Profile %s (%s) is now the default", name, ws.Value)
			} else {
				u.Successf("Profile %s is now the default", name)
			}
			return nil
		},
	}
}

// caller is GetCaller's answer: who the credential acts for.
type caller struct {
	UserID       string          `json:"userId,omitempty"`
	APIClientID  string          `json:"apiClientId,omitempty"`
	DisplayName  string          `json:"displayName,omitempty"`
	Credential   string          `json:"credential,omitempty"`
	Scopes       []string        `json:"scopes,omitempty"`
	Organisation json.RawMessage `json:"organisation,omitempty"`
	raw          json.RawMessage
	apiVersion   string
}

func (c *caller) label() string {
	switch {
	case c.DisplayName != "":
		return c.DisplayName
	case c.APIClientID != "":
		return "API client " + c.APIClientID
	}
	return c.UserID
}

func (c *caller) organisation() string {
	var o struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(c.Organisation, &o)
	return o.Name
}

// getCaller calls GetCaller (GET /v3/me), the generated `me` command's operation, with a credential of its own.
func getCaller(ctx context.Context, f *cmdutil.Factory, ws string, a core.Auth) (*caller, error) {
	opts, err := f.ClientOptions()
	if err != nil {
		return nil, err
	}
	cc, err := core.NewClient(core.SDKInfo{Version: core.ModuleVersion(caitlyn.ModulePath, caitlyn.SDKVersion), ModelVersion: caitlyn.ModelVersion}, ws, a, opts...)
	if err != nil {
		return nil, err
	}
	return callGetCaller(ctx, f, cc)
}

func callGetCaller(ctx context.Context, f *cmdutil.Factory, cc *core.Client) (*caller, error) {
	op := f.Manifest().Op("GetCaller")
	if op == nil {
		return nil, fmt.Errorf("this CLI's manifest has no GetCaller operation")
	}
	res, err := invoke.Call(ctx, cc, op, invoke.NewInput())
	if err != nil {
		return nil, err
	}
	c := &caller{raw: res.Body, apiVersion: res.Header.Get("Caitlyn-Api-Version")}
	if err := json.Unmarshal(res.Body, c); err != nil {
		return nil, fmt.Errorf("GetCaller's answer could not be read: %w", err)
	}
	if cfg, err := f.Config(); err == nil && c.label() != "" {
		saveIdentity(cfg.Dir(), cfg.Profile(), c.label())
	}
	return c, nil
}

func newStatusCmd(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the workspace, who you're signed in as, and how",
		Long: `Show the profile's workspace first, then who the credential acts for (from GetCaller), the credential and
its scopes, when the access token expires, where it is kept, and what an AI agent may do with the profile.

-o json prints the same as one JSON object.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return runStatus(cmd.Context(), f) },
	}
}

// statusReport is auth status as data (-o json).
type statusReport struct {
	Workspace  string          `json:"workspace"`
	Profile    string          `json:"profile"`
	SignedInAs json.RawMessage `json:"signedInAs,omitempty"`
	Credential credentialInfo  `json:"credential"`
	Agent      agentInfo       `json:"agent"`
	APIVersion string          `json:"apiVersion,omitempty"`
	CLIVersion string          `json:"cliVersion,omitempty"`
}

type credentialInfo struct {
	Mode            string   `json:"mode"`
	Scopes          []string `json:"scopes,omitempty"`
	ExpiresAt       string   `json:"expiresAt,omitempty"`
	Storage         string   `json:"storage"`
	InsecureStorage bool     `json:"insecureStorage"`
}

type agentInfo struct {
	// Active is agent mode in this run: the token used was the agent's.
	Active  bool     `json:"active"`
	Name    string   `json:"name,omitempty"`
	Setting []string `json:"setting"`
	Scopes  []string `json:"scopes"`
	// Enforcement is server (the workspace issued a narrowed token), cli (the CLI's own pre-check only, until the
	// workspace narrows), cli-credential (the CLI's pre-check only: the credential has no refresh token) or unknown
	// (no agent has used this sign-in yet).
	Enforcement    string `json:"enforcement"`
	ServerNarrowed bool   `json:"serverNarrowed"`
}

func runStatus(ctx context.Context, f *cmdutil.Factory) error {
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return err
	}
	who, err := callGetCaller(ctx, f, cc)
	if err != nil {
		return err
	}
	cfg, _ := f.Config()
	ws, _ := f.Workspace()
	ws = core.WorkspaceHost(ws)
	info := f.AuthInfo()
	if info == nil {
		info = &cmdutil.AuthInfo{}
	}
	r := statusReport{Workspace: ws, Profile: cfg.Profile(), SignedInAs: who.raw, APIVersion: who.apiVersion, CLIVersion: f.Version}
	r.Credential = credentialInfo{Mode: info.Mode, Scopes: info.Scopes, Storage: info.Storage}
	if len(r.Credential.Scopes) == 0 {
		r.Credential.Scopes = who.Scopes
	}
	var s *session
	if p, ok := f.Auth.(*Provider); ok {
		s = p.session()
	}
	if s != nil {
		r.Credential.InsecureStorage = s.store.Insecure()
		if cur := s.Current(); cur != nil && !cur.ExpiresAt.IsZero() {
			r.Credential.ExpiresAt = cur.ExpiresAt.UTC().Format(time.RFC3339)
		}
	} else if info.Mode == ModeToken && !strings.HasPrefix(info.Storage, "the environment") {
		r.Credential.InsecureStorage = cfg.Bool("insecure_storage")
	}
	r.Agent = agentStatus(f, info, s)
	p, err := output.New(f, gen.UIFor(f))
	if err != nil {
		return err
	}
	if p.Format != output.Table || p.Filtered() {
		return p.Value(r, "")
	}
	printStatus(f, gen.UIFor(f), r, who)
	return nil
}

// agentStatus says what an AI agent may do with the profile, and who enforces it.
func agentStatus(f *cmdutil.Factory, info *cmdutil.AuthInfo, s *session) agentInfo {
	cfg, _ := f.Config()
	readOnly := cfg.Bool("read_only") || truthy(f.IO.Getenv("CAITLYN_READ_ONLY"))
	a := agentInfo{Active: f.Agent.On, Name: f.Agent.Name, Setting: AgentSetting(cfg), Enforcement: "cli"}
	switch {
	case info.AgentScopes != nil:
		a.Scopes = info.AgentScopes
	default:
		var granted []string
		if info.Scopes != nil {
			granted = info.Scopes
		}
		a.Scopes = agent.Effective(a.Setting, granted, readOnly)
	}
	if info.Mode != ModeOAuth || s == nil {
		// Only an OAuth sign-in has a refresh token to narrow: with any other credential (a personal access token
		// saved with --with-token, a client secret, a workload identity), only the CLI's own pre-check applies
		a.Enforcement = "cli-credential"
		return a
	}
	if f.Agent.On {
		a.ServerNarrowed = info.ServerNarrowed
	} else {
		// A person's status: what the last agent token for these scopes showed, if there is one
		e, _ := s.store.Load(agent.CacheKey(s.store.Workspace, s.store.Profile, a.Scopes))
		if e == nil {
			a.Enforcement = "unknown"
			return a
		}
		a.ServerNarrowed = e.Narrowed
	}
	if a.ServerNarrowed {
		a.Enforcement = "server"
	}
	return a
}

func printStatus(f *cmdutil.Factory, u *ui.UI, r statusReport, who *caller) {
	w := f.IO.Out
	row := func(label, value string) {
		fmt.Fprintf(w, "  %s  %s\n", u.S(ui.Muted, fmt.Sprintf("%-13s", label)), value)
	}
	fmt.Fprintf(w, "%s  %s\n", u.S(ui.Strong, r.Workspace), u.S(ui.Muted, "(profile "+r.Profile+")"))
	name := who.label()
	if org := who.organisation(); org != "" {
		name += ", " + org
	}
	row("Signed in as", name)
	cred := describeMode(r.Credential.Mode)
	if len(r.Credential.Scopes) > 0 {
		cred += ", scopes " + strings.Join(r.Credential.Scopes, " ")
	}
	row("Credential", cred)
	switch {
	case r.Credential.ExpiresAt != "":
		exp, _ := time.Parse(time.RFC3339, r.Credential.ExpiresAt)
		row("Access token", "expires "+relative(exp.Sub(f.Now()))+"; refreshes automatically")
	case r.Credential.Mode == ModeToken:
		row("Access token", "a personal access token: it works until it expires or is revoked in Caitlyn")
	default:
		row("Access token", "a new one at each sign-in")
	}
	row("Stored in", r.Credential.Storage)
	agentLine := agent.Describe(r.Agent.Setting)
	if len(r.Agent.Scopes) > 0 && !(len(r.Agent.Setting) == 1 && r.Agent.Setting[0] == agent.None) {
		agentLine += " (" + strings.Join(r.Agent.Scopes, " ") + ")"
	}
	switch r.Agent.Enforcement {
	case "server":
		agentLine += "; the workspace issues agents a narrowed token"
	case "cli":
		agentLine += "; enforced by the CLI only: the workspace doesn't narrow agent tokens yet"
	case "cli-credential":
		agentLine += "; enforced by the CLI only: this credential has no refresh token to narrow, so an agent's calls carry its full scopes. For a hard boundary, give the agent a credential of its own with only the scopes it needs"
	default:
		agentLine += "; no agent has used this sign-in yet"
	}
	row("Agent scopes", agentLine)
	if r.Agent.Active {
		name := r.Agent.Name
		if name == "" {
			name = "an AI agent"
		}
		row("Agent mode", "on ("+name+"): this command used the agent's token")
	}
	if r.APIVersion != "" {
		row("Workspace", "Caitlyn "+r.APIVersion+" (CLI "+r.CLIVersion+")")
	}
	if r.Credential.InsecureStorage {
		fmt.Fprintln(w)
		fmt.Fprintf(w, "%s %s\n", u.S(ui.Warning, u.G.Warning), "Insecure storage: tokens are in a file any program running as you can read, not the keychain. Sign in without --insecure-storage where a keychain is available.")
	}
}

func describeMode(mode string) string {
	switch mode {
	case ModeOAuth:
		return "OAuth (Caitlyn CLI)"
	case ModeToken:
		return "Personal access token"
	case ModeClientCredentials:
		return "API client (client credentials)"
	case ModeWorkloadIdentity:
		return "Workload identity"
	case ModeAWSIAM:
		return "AWS IAM"
	}
	return mode
}

// relative says how long until d, for people: "in 52 minutes", "in 3 hours", "2 minutes ago".
func relative(d time.Duration) string {
	past := d < 0
	if past {
		d = -d
	}
	var s string
	switch {
	case d < time.Minute:
		s = "less than a minute"
	case d < 2*time.Minute:
		s = "1 minute"
	case d < time.Hour:
		s = fmt.Sprintf("%d minutes", int(d.Minutes()))
	case d < 2*time.Hour:
		s = "1 hour"
	case d < 48*time.Hour:
		s = fmt.Sprintf("%d hours", int(d.Hours()))
	default:
		s = fmt.Sprintf("%d days", int(d.Hours()/24))
	}
	if past {
		return s + " ago"
	}
	return "in " + s
}
