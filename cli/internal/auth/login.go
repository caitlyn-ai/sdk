package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
	"github.com/caitlyn-ai/sdk/go/core"
)

// loginWait is how long browser sign-in waits for the person to approve, unless --timeout says otherwise.
const loginWait = 10 * time.Minute

type loginOptions struct {
	device, withToken, readOnly, insecure bool
	scopes                                []string
	outputDefault, agentOutput            string
	agentScopes                           string
}

func newLoginCmd(f *cmdutil.Factory, use string) *cobra.Command {
	o := &loginOptions{}
	cmd := &cobra.Command{
		Use:   use,
		Short: "Sign in to a workspace",
		Long: `Sign in to a Caitlyn workspace and save it as a profile.

By default the CLI opens your browser at the workspace's sign-in page; approve there, after checking that it names
"Caitlyn CLI" and the workspace. On a machine with no browser, --device shows a code to approve from any other
device. --with-token reads a personal access token from stdin instead.

Tokens go to your operating system's keychain, never to the configuration file. Where there is no keychain,
--insecure-storage keeps them in ~/.caitlyn/credentials (readable only by you), and auth status says so every time.

At a terminal, sign-in then asks how the profile shows output, and what an AI agent may do with it. Elsewhere, the
--output-default, --agent-output and --agent-scopes flags answer those questions; without them nothing is saved.

In CI, sign in with the pipeline's own identity instead: https://build.caitlyn.ai/cli/ci/#signing-in-without-secrets`,
		Example: `  caitlyn auth login --workspace your-company.caitlyn.ai
  caitlyn auth login --profile staging --workspace your-company-staging.caitlyn.ai --read-only
  caitlyn auth login --device
  caitlyn auth login --with-token < token.txt`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !cmd.Flags().Changed("scopes") {
				o.scopes = nil
			}
			return runLogin(cmd.Context(), f, o)
		},
	}
	fl := cmd.Flags()
	fl.BoolVar(&o.device, "device", false, "Sign in with a code approved on another device (RFC 8628), for a terminal with no browser")
	fl.BoolVar(&o.withToken, "with-token", false, "Read a personal access token from stdin")
	fl.BoolVar(&o.readOnly, "read-only", false, "Ask for the api:read scope only, and refuse every command that writes with this profile")
	fl.StringSliceVar(&o.scopes, "scopes", []string{"api:admin"}, "The scopes to ask for; the workspace narrows them to your own permissions")
	fl.BoolVar(&o.insecure, "insecure-storage", false, "Keep tokens in ~/.caitlyn/credentials (mode 0600) instead of the keychain")
	fl.StringVar(&o.outputDefault, "output-default", "", "The profile's default output: auto, table, json, jsonl, yaml or text")
	fl.StringVar(&o.agentOutput, "agent-output", "", "The output when an AI agent uses the profile: json, yaml, text or same")
	fl.StringVar(&o.agentScopes, "agent-scopes", "", "What an AI agent may do with the profile: read-only, full, none, or scopes separated by commas")
	return cmd
}

func runLogin(ctx context.Context, f *cmdutil.Factory, o *loginOptions) error {
	if f.CI.In() {
		e := cmdutil.Usagef("auth login doesn't run in CI: sign in with the pipeline's own identity instead.")
		e.Code = "LOGIN_IN_CI"
		e.Detail = fmt.Sprintf("%s was detected (%s). Every sign-in mode works from environment variables alone, and a workload identity needs no stored secret.", ciName(f.CI.Name), f.CI.Reason)
		e.Hint = &cmdutil.Hint{Docs: "https://build.caitlyn.ai/cli/ci/#signing-in-without-secrets"}
		e.AddNext("export CAITLYN_AUTH=workload-identity CAITLYN_WORKSPACE=your-company.caitlyn.ai", "sign in with the pipeline's OIDC token (GitLab id_tokens, GitHub Actions, Buildkite)")
		return e
	}
	if o.device && f.Agent.On {
		e := cmdutil.Forbiddenf("DEVICE_SIGN_IN_REFUSED", "Device sign-in is refused to AI agents.")
		e.Detail = "Relaying a sign-in code is how device-code phishing works, so only a person may start it."
		e.AddNext("caitlyn auth login", "sign in with the browser; the approval there is the person's")
		return e
	}
	if o.device && o.withToken {
		return cmdutil.Usagef("--device and --with-token are two ways to sign in: choose one.")
	}
	if o.readOnly && o.scopes != nil {
		return cmdutil.Usagef("--read-only asks for api:read only, so it can't be used with --scopes.")
	}
	if err := checkChoice("--output-default", o.outputDefault, outputChoices); err != nil {
		return err
	}
	if err := checkChoice("--agent-output", o.agentOutput, agentOutputChoices); err != nil {
		return err
	}
	agentScopes, err := parseAgentScopes(o.agentScopes)
	if err != nil {
		return err
	}
	cfg, err := f.Config()
	if err != nil {
		return err
	}
	ws, err := loginWorkspace(f, cfg.String("workspace"))
	if err != nil {
		return err
	}
	profile := cfg.Profile()
	insecure := o.insecure || cfg.Bool("insecure_storage")
	st := newStore(cfg.Dir(), homeDir(f), ws, profile, insecure)
	// Before anyone is asked to approve anything: there must be somewhere to keep the tokens
	if err := st.b.probe(); err != nil {
		return err
	}
	scopes := o.scopes
	switch {
	case o.readOnly:
		scopes = []string{"api:read"}
	case scopes == nil && len(cfg.Get("scopes").List) > 0:
		scopes = cfg.Get("scopes").List
	case scopes == nil:
		scopes = []string{"api:admin"}
	}
	oc := newOAuthClient(ws, cfg.String("endpoint"), httpClient(f), userAgent(f), nowFunc(f))
	u := gen.UIFor(f)

	var entry *Entry
	switch {
	case o.withToken:
		entry, err = readToken(f)
	case o.device:
		entry, err = deviceLogin(ctx, f, u, oc, ws, scopes)
	default:
		entry, err = browserLogin(ctx, f, u, oc, cfg.String("browser"), ws, scopes)
	}
	if err != nil {
		return err
	}

	who, callerErr := getCaller(ctx, f, ws, core.Token(entry.AccessToken))
	if callerErr != nil && entry.Kind == "token" {
		// A personal access token is checked before it is kept: a mistyped one is never saved
		return callerErr
	}
	err = st.WithLock(ctx, func(context.Context) error {
		if old, _ := st.Load(st.PersonKey()); old != nil && old.AgentKey != "" {
			// a new grant: an agent token from the old one is never used again
			_ = st.Delete(old.AgentKey)
		}
		return st.Save(st.PersonKey(), entry)
	})
	if err != nil {
		return err
	}

	if who != nil && who.label() != "" {
		u.Successf("Signed in to %s as %s", ws, who.label())
	} else {
		u.Successf("Signed in to %s", ws)
		if callerErr != nil {
			u.Warnf("Couldn't read who you are signed in as: %s", cmdutil.FromError(callerErr).Title)
		}
	}
	detail := []string{"profile " + profile, "tokens in " + st.StorageName()}
	if entry.Scope != "" {
		detail = append(detail, "scopes "+entry.Scope)
	}
	u.Infof("  %s", strings.Join(detail, " "+u.G.Dot+" "))
	if st.Insecure() {
		u.Warnf("Tokens are in %s, readable by any program running as you. auth status says so every time.", st.StorageName())
	}

	values := map[string]string{"workspace": ws, "auth": ModeOAuth}
	if entry.Kind == "token" {
		values["auth"] = ModeToken
	}
	if o.insecure {
		values["insecure_storage"] = "true"
	}
	if o.readOnly {
		values["read_only"] = "true"
	}
	if o.scopes != nil {
		values["scopes"] = strings.Join(o.scopes, ",")
	}
	asked, err := askProfileQuestions(f, o, agentScopes, entry.Scopes(), values)
	if err != nil {
		return err
	}
	if err := cfg.SetProfile(profile, values); err != nil {
		return fmt.Errorf("signed in, but profile %s could not be saved: %w", profile, err)
	}
	if asked {
		u.Successf("Saved to profile %s. Change it any time: caitlyn config set output %s --profile %s", profile, u.G.Ellipsis, profile)
	} else {
		u.Infof("Saved as profile %s.", profile)
	}
	return nil
}

func ciName(name string) string {
	switch name {
	case "gitlab":
		return "GitLab CI"
	case "github":
		return "GitHub Actions"
	case "buildkite":
		return "Buildkite"
	case "":
		return "CI"
	}
	return "CI (" + name + ")"
}

// loginWorkspace is the workspace to sign in to: --workspace, CAITLYN_WORKSPACE or the profile's, else asked for.
func loginWorkspace(f *cmdutil.Factory, ws string) (string, error) {
	if ws == "" {
		p, err := prompt.For(f.IO)
		if err != nil {
			e := cmdutil.ActionNeeded("Which workspace? Name it with --workspace.", "--workspace")
			e.AddNext("caitlyn auth login --workspace your-company.caitlyn.ai", "sign in to your workspace")
			return "", e
		}
		if ws, err = p.Input("Workspace (for example your-company.caitlyn.ai)", ""); err != nil {
			return "", err
		}
	}
	host, err := core.ParseWorkspace(ws)
	if err != nil {
		e := cmdutil.Usagef("%q is not a workspace.", ws)
		e.Detail = "A workspace is a hostname such as your-company.caitlyn.ai, or its https:// URL."
		return "", e
	}
	return host, nil
}

// readToken reads a personal access token from stdin (never a flag value, so it stays out of shell history).
func readToken(f *cmdutil.Factory) (*Entry, error) {
	if f.IO.IsStdinTTY() {
		e := cmdutil.Usagef("--with-token reads the token from stdin: pipe it in.")
		e.AddNext("caitlyn auth login --with-token < token.txt", "sign in with a token kept in a file")
		return nil, e
	}
	b, err := io.ReadAll(io.LimitReader(f.IO.In, 64<<10))
	if err != nil {
		return nil, fmt.Errorf("the token could not be read from stdin: %w", err)
	}
	tok := strings.TrimSpace(string(b))
	if tok == "" || strings.ContainsAny(tok, " \t\r\n") {
		return nil, cmdutil.Usagef("stdin held no token: --with-token expects one personal access token.")
	}
	return &Entry{Kind: "token", AccessToken: tok}, nil
}

// browserLogin is the authorisation code flow with PKCE through a loopback redirect (5.2, RFC 8252).
func browserLogin(ctx context.Context, f *cmdutil.Factory, u *ui.UI, oc *oauthClient, browser, ws string, scopes []string) (*Entry, error) {
	state := randomString(16)
	pk := newPKCE()
	lb, err := listenLoopback(state)
	if err != nil {
		return nil, err
	}
	defer lb.close()
	authURL := oc.authorizationURL(lb.RedirectURI, state, pk, scopes)
	e := f.IO.ErrOut
	fmt.Fprintf(e, "%s\n\n", u.E(ui.Strong, "Signing in to "+ws))
	opened := openBrowser(ctx, browser, authURL) == nil
	if opened {
		fmt.Fprintf(e, "  Your browser is open at the sign-in page. Check that it names\n  \"Caitlyn CLI\" and %s, then approve.\n\n", ws)
		fmt.Fprintf(e, "  Not opened? %s\n", u.Err.Hyperlink(authURL, authURL))
	} else {
		fmt.Fprintf(e, "  Open this page to sign in. Check that it names \"Caitlyn CLI\" and %s, then approve.\n\n", ws)
		fmt.Fprintf(e, "  %s\n", u.Err.Hyperlink(authURL, authURL))
	}
	fmt.Fprintf(e, "%s\n", u.E(ui.Muted, "Waiting for you to approve"+u.G.Ellipsis))
	wait := loginWait
	if f.Globals != nil && f.Globals.Timeout > 0 {
		wait = f.Globals.Timeout
	}
	wctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	code, err := lb.wait(wctx)
	if err != nil {
		return nil, err
	}
	g, err := oc.exchangeCode(ctx, code, lb.RedirectURI, pk)
	if err != nil {
		return nil, err
	}
	return oauthEntry(g, scopes), nil
}

// deviceLogin is the device authorisation grant (RFC 8628): a code the person approves on any other device.
func deviceLogin(ctx context.Context, f *cmdutil.Factory, u *ui.UI, oc *oauthClient, ws string, scopes []string) (*Entry, error) {
	d, err := oc.startDevice(ctx, scopes)
	if err != nil {
		return nil, err
	}
	e := f.IO.ErrOut
	fmt.Fprintf(e, "%s\n\n", u.E(ui.Strong, "Signing in to "+ws+" with a code"))
	fmt.Fprintf(e, "  On any device, open %s\n", u.Err.Hyperlink(d.VerificationURI, d.VerificationURI))
	fmt.Fprintf(e, "  and enter the code %s\n\n", u.E(ui.Strong, d.UserCode))
	fmt.Fprintf(e, "  Check that the page names \"Caitlyn CLI\" and %s before you approve.\n", ws)
	fmt.Fprintf(e, "  Only approve a code you asked for yourself, just now.\n\n")
	fmt.Fprintf(e, "%s\n", u.E(ui.Muted, fmt.Sprintf("Waiting for you to approve (the code expires in %d minutes)%s", (d.ExpiresIn+59)/60, u.G.Ellipsis)))
	g, err := oc.pollDevice(ctx, d)
	if err != nil {
		return nil, err
	}
	return oauthEntry(g, scopes), nil
}

func oauthEntry(g *granted, asked []string) *Entry {
	scope := g.Scope
	if !g.ScopeGiven || scope == "" {
		scope = strings.Join(asked, " ")
	}
	return &Entry{Kind: "oauth", AccessToken: g.AccessToken, RefreshToken: g.RefreshToken, ExpiresAt: g.ExpiresAt, Scope: scope}
}

// The answers the three sign-in questions take (12.10, 13.5).
var (
	outputChoices      = []string{"auto", "table", "json", "jsonl", "yaml", "text"}
	agentOutputChoices = []string{"json", "yaml", "text", "same"}
)

func checkChoice(flag, v string, choices []string) error {
	if v == "" {
		return nil
	}
	for _, c := range choices {
		if v == c {
			return nil
		}
	}
	return cmdutil.Usagef("%s takes %s, not %q.", flag, strings.Join(choices, ", "), v)
}

// parseAgentScopes checks --agent-scopes: a preset, or scopes such as agents:read separated by commas.
func parseAgentScopes(v string) ([]string, error) {
	if strings.TrimSpace(v) == "" {
		return nil, nil
	}
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	for _, s := range out {
		switch s {
		case agent.ReadOnly, agent.Full, agent.None:
			if len(out) > 1 {
				return nil, cmdutil.Usagef("--agent-scopes takes %s on its own, not in a list.", s)
			}
		}
	}
	// the same check as the configuration file's: a known area or api: at read, write or admin, never mcp:
	if err := config.CheckAgentScopes(out); err != nil {
		return nil, cmdutil.Usagef("--agent-scopes: %v.", err)
	}
	return out, nil
}

// askProfileQuestions sets output, agent_output and agent_scopes in values: from the flags, or by asking a person at
// a terminal (12.10). With neither, the key is left out, so the built-in defaults apply. It reports whether anything
// was chosen.
func askProfileQuestions(f *cmdutil.Factory, o *loginOptions, agentScopes, granted []string, values map[string]string) (bool, error) {
	chosen := false
	if o.outputDefault != "" {
		values["output"], chosen = o.outputDefault, true
	}
	if o.agentOutput != "" {
		values["agent_output"], chosen = o.agentOutput, true
	}
	if agentScopes != nil {
		values["agent_scopes"], chosen = strings.Join(agentScopes, ","), true
	}
	p, err := prompt.For(f.IO)
	if err != nil {
		return chosen, nil
	}
	if o.outputDefault == "" {
		i, err := p.Select("How should this profile show output by default?", []prompt.Option{
			{Label: "Tables for people, JSON when piped (recommended)", Value: "auto"},
			{Label: "Always JSON", Value: "json"},
			{Label: "Always YAML", Value: "yaml"},
		}, 0)
		if err != nil {
			return chosen, stopAsking(f, err)
		}
		values["output"], chosen = []string{"auto", "json", "yaml"}[i], true
	}
	if o.agentOutput == "" {
		i, err := p.Select("And when an AI agent uses this profile?", []prompt.Option{
			{Label: "JSON (recommended)", Value: "json"},
			{Label: "The same as above", Value: "same"},
		}, 0)
		if err != nil {
			return chosen, stopAsking(f, err)
		}
		values["agent_output"], chosen = []string{"json", "same"}[i], true
	}
	if agentScopes == nil {
		i, err := p.Select("What may an AI agent do with this profile?", []prompt.Option{
			{Label: "Read only: look, never change (recommended)", Value: agent.ReadOnly},
			{Label: "Everything you can", Value: agent.Full},
			{Label: "Nothing: refuse agents", Value: agent.None},
			{Label: "Choose scopes" + "…", Value: "choose"},
		}, 0)
		if err != nil {
			return chosen, stopAsking(f, err)
		}
		choice := []string{agent.ReadOnly, agent.Full, agent.None, "choose"}[i]
		if choice == "choose" {
			opts := scopeOptions(granted)
			idx, err := p.MultiSelect("Which scopes may an AI agent use? Only scopes this sign-in holds are offered.", opts, nil)
			if err != nil {
				return chosen, stopAsking(f, err)
			}
			var picked []string
			for _, j := range idx {
				picked = append(picked, opts[j].Value)
			}
			if len(picked) == 0 {
				fmt.Fprintln(f.IO.ErrOut, "No scopes were chosen, so agents may read only.")
				choice = agent.ReadOnly
			} else {
				choice = strings.Join(picked, ",")
			}
		}
		values["agent_scopes"], chosen = choice, true
	}
	return chosen, nil
}

// scopeOptions lists the scopes a sign-in holds, family by family from the overlay's scope catalogue, each with its
// plain description.
func scopeOptions(granted []string) []prompt.Option {
	catalogue := spec.MustOverlay().Scopes
	fams := make([]string, 0, len(catalogue))
	for fam := range catalogue {
		fams = append(fams, fam)
	}
	sort.Strings(fams)
	var out []prompt.Option
	for _, fam := range fams {
		for _, tier := range []string{"read", "write", "admin"} {
			s := fam + ":" + tier
			if agent.AnyCovers(granted, s) {
				out = append(out, prompt.Option{Label: s, Description: catalogue[fam], Value: s})
			}
		}
	}
	return out
}

// stopAsking ends the questions early (stdin closed, say): what was answered is kept, the rest keep their defaults.
func stopAsking(f *cmdutil.Factory, err error) error {
	if errors.Is(err, io.EOF) {
		fmt.Fprintln(f.IO.ErrOut, "No answer was given, so the remaining questions keep their defaults.")
		return nil
	}
	return err
}
