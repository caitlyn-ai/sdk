// Package cmdutil is what every command shares: the Factory (streams, configuration, the manifest, the clients),
// the global flags, and the CLI's error type.
package cmdutil

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/traces"
	"github.com/caitlyn-ai/sdk/cli/internal/useragent"
	caitlyn "github.com/caitlyn-ai/sdk/go"
	"github.com/caitlyn-ai/sdk/go/core"
)

// Globals are the flags every command takes.
type Globals struct {
	Profile       string
	Workspace     string
	Output        string
	ErrorFormat   string
	Query         string
	JQ            string
	Color         string
	NoColor       bool
	NoPager       bool
	NoInput       bool
	Yes           bool
	Confirm       string
	DryRun        string
	Debug         string
	Timeout       time.Duration
	ProjectFile   string
	NoProjectFile bool
	ReadOnly      bool
	CIFormat      string
	Reports       []string
	SummaryFile   string
	OutputsFile   string
	FailOn        []string
}

// AuthRequest is what a command needs from sign-in.
type AuthRequest struct {
	Profile   string
	Workspace string
	Endpoint  string
	// Agent is agent mode: the CLI asks for the profile's narrower agent token (18.5).
	Agent bool
}

// AuthInfo describes the credential in use, for `auth status`, debug output and agent-scope checks.
type AuthInfo struct {
	Mode string
	// Scopes the credential was granted, when known.
	Scopes []string
	// AgentScopes is the narrower set used in agent mode (nil: the same as Scopes).
	AgentScopes []string
	// ServerNarrowed is false while the server ignores a narrower scope on refresh: agent scopes are then
	// enforced by the CLI only.
	ServerNarrowed bool
	Storage        string
}

// AuthProvider signs in. Package auth implements it; the root command wires it into the Factory.
type AuthProvider interface {
	Auth(ctx context.Context, f *Factory, req AuthRequest) (core.Auth, *AuthInfo, error)
}

// Factory is built once per run and handed to every command.
type Factory struct {
	IO      *iostreams.IOStreams
	Globals *Globals
	Version string
	Agent   agent.Mode
	// Traces is this run's "your own traces" (package traces): set before the command runs, and On only when an OTLP
	// endpoint is set. Unrelated to usage data for Caitlyn.
	Traces *traces.Run
	CI     ci.Provider
	Now    func() time.Time
	Auth   AuthProvider
	// HTTPClient replaces the default HTTP client (tests).
	HTTPClient *http.Client
	// Getwd and Home let tests run the CLI in a temporary folder.
	WorkDir, Home string

	cfgOnce sync.Once
	cfg     *config.Config
	cfgErr  error

	clientMu  sync.Mutex
	core      *core.Client
	typed     *caitlyn.Client
	authInfo  *AuthInfo
	clientErr error
}

// Config loads the configuration once.
func (f *Factory) Config() (*config.Config, error) {
	f.cfgOnce.Do(func() {
		g := f.Globals
		f.cfg, f.cfgErr = config.Load(config.Options{
			Getenv:        f.IO.Getenv,
			Home:          f.Home,
			WorkDir:       f.WorkDir,
			ProjectFile:   g.ProjectFile,
			NoProjectFile: g.NoProjectFile,
			Profile:       g.Profile,
		})
		if f.cfgErr != nil {
			if fe, ok := f.cfgErr.(*config.FileError); ok {
				f.cfgErr = &Error{Exit: exitcode.Usage, Code: "CONFIG_INVALID", Title: "The configuration can't be used.", Detail: fe.Error(), Cause: fe}
			}
			return
		}
		if g.Workspace != "" {
			f.cfg.Override("workspace", g.Workspace)
		}
	})
	return f.cfg, f.cfgErr
}

// Manifest is the embedded command manifest.
func (f *Factory) Manifest() *spec.Manifest { return spec.MustLoad() }

// Overlay is the embedded naming overlay.
func (f *Factory) Overlay() *spec.Overlay { return spec.MustOverlay() }

// Workspace is the workspace in use, or a usage error naming how to choose one.
func (f *Factory) Workspace() (string, error) {
	cfg, err := f.Config()
	if err != nil {
		return "", err
	}
	// A project file naming a workspace that's none of the user's own is refused, not ignored: the person sees why
	// their command doesn't go where the repository says (13.3). --workspace and CAITLYN_WORKSPACE still choose.
	if perr := cfg.ProjectWorkspaceError(); perr != nil {
		if o := cfg.Get("workspace").Origin; o != config.FromFlag && o != config.FromEnv {
			return "", &Error{Exit: exitcode.Usage, Code: "CONFIG_INVALID", Title: "The project file's workspace can't be used.", Detail: perr.Error(), Cause: perr}
		}
	}
	ws := cfg.String("workspace")
	if ws == "" {
		e := Usagef("No workspace is chosen.")
		e.Code = "NO_WORKSPACE"
		e.Exit = exitcode.Auth
		e.Detail = "Sign in to one, or name it with --workspace or CAITLYN_WORKSPACE."
		e.AddNext("caitlyn auth login --workspace your-company.caitlyn.ai", "sign in to your workspace")
		return "", e
	}
	return ws, nil
}

// AppID is the user agent's app/ token: the CLI and its version. The CI system and the AI agent go in their own
// tokens (ci/, agent/), from UserAgentCI and UserAgentAgent, through core.WithCI and core.WithAgent.
func (f *Factory) AppID() string { return "caitlyn-cli#" + f.Version }

// UserAgentCI is the ci/ token's value: the CI system detected, normalised (see userAgentToken), or "" when not in CI
// or nothing valid is left, and the token is left out.
func (f *Factory) UserAgentCI() string {
	if !f.CI.In() {
		return ""
	}
	return userAgentToken(f.CI.Name)
}

// UserAgentAgent is the agent/ token's value: the AI agent detected or named, normalised (see userAgentToken), or
// "unknown" when one is driving the CLI but its name is empty or leaves nothing valid; "" outside agent mode.
func (f *Factory) UserAgentAgent() string {
	if !f.Agent.On {
		return ""
	}
	if name := userAgentToken(f.Agent.Name); name != "" {
		return name
	}
	return "unknown"
}

// userAgentToken is useragent.Token: the form core.WithCI and core.WithAgent accept, so a name the CLI is told can
// never stop it building a client.
func userAgentToken(name string) string { return useragent.Token(name) }

// UserAgentSuffix is the app/ id with the declared ci/ and agent/ tokens, as the SDK writes them after app/: for the
// sign-in requests, which don't go through the SDK's client.
func (f *Factory) UserAgentSuffix() string {
	s := f.AppID()
	if ci := f.UserAgentCI(); ci != "" {
		s += " ci/" + ci
	}
	if a := f.UserAgentAgent(); a != "" {
		s += " agent/" + a
	}
	return s
}

// ClientOptions are the options both clients are built with.
func (f *Factory) ClientOptions() ([]core.Option, error) {
	cfg, err := f.Config()
	if err != nil {
		return nil, err
	}
	opts := []core.Option{core.WithAppID(f.AppID())}
	if ci := f.UserAgentCI(); ci != "" {
		opts = append(opts, core.WithCI(ci))
	}
	if a := f.UserAgentAgent(); a != "" {
		opts = append(opts, core.WithAgent(a))
	}
	// Your own traces: the SDK's span per call, under the command's root span, and traceparent on each request
	if f.Traces.On() {
		opts = append(opts, core.WithTracerProvider(f.Traces.Provider), core.WithPropagator(f.Traces.Propagator))
	}
	if ep := cfg.String("endpoint"); ep != "" {
		opts = append(opts, core.WithEndpoint(ep))
	}
	if f.HTTPClient != nil {
		opts = append(opts, core.WithHTTPClient(f.HTTPClient))
	} else if f.Globals.Debug != "" {
		opts = append(opts, core.WithHTTPClient(&http.Client{Transport: &DebugTransport{IO: f.IO, Bodies: f.Globals.Debug == "body"}}))
	}
	return opts, nil
}

// Clients returns the runtime client (generated commands send through it) and the typed SDK client (the
// hand-written commands use the SDK's helpers: sync, wait, chat), signed in once.
func (f *Factory) Clients(ctx context.Context) (*core.Client, *caitlyn.Client, error) {
	f.clientMu.Lock()
	defer f.clientMu.Unlock()
	if f.core != nil || f.clientErr != nil {
		return f.core, f.typed, f.clientErr
	}
	f.core, f.typed, f.clientErr = f.newClients(ctx)
	return f.core, f.typed, f.clientErr
}

// AuthInfo describes the credential the clients use (after Clients).
func (f *Factory) AuthInfo() *AuthInfo {
	f.clientMu.Lock()
	defer f.clientMu.Unlock()
	return f.authInfo
}

func (f *Factory) newClients(ctx context.Context) (*core.Client, *caitlyn.Client, error) {
	ws, err := f.Workspace()
	if err != nil {
		return nil, nil, err
	}
	cfg, _ := f.Config()
	if f.Auth == nil {
		return nil, nil, fmt.Errorf("no sign-in is configured")
	}
	auth, info, err := f.Auth.Auth(ctx, f, AuthRequest{Profile: cfg.Profile(), Workspace: ws, Endpoint: cfg.String("endpoint"), Agent: f.Agent.On})
	if err != nil {
		return nil, nil, err
	}
	f.authInfo = info
	opts, err := f.ClientOptions()
	if err != nil {
		return nil, nil, err
	}
	cc, err := core.NewClient(core.SDKInfo{Version: core.ModuleVersion(caitlyn.ModulePath, caitlyn.SDKVersion), ModelVersion: caitlyn.ModelVersion}, ws, auth, opts...)
	if err != nil {
		return nil, nil, &Error{Exit: exitcode.Usage, Code: "USAGE", Title: strings.TrimPrefix(err.Error(), "caitlyn: "), Cause: err}
	}
	tc, err := caitlyn.NewClient(ws, auth, opts...)
	if err != nil {
		return nil, nil, &Error{Exit: exitcode.Usage, Code: "USAGE", Title: strings.TrimPrefix(err.Error(), "caitlyn: "), Cause: err}
	}
	return cc, tc, nil
}

// Interactive reports whether a person is at a terminal the CLI may prompt on.
func (f *Factory) Interactive() bool { return f.IO.CanPrompt() }

// Stderrf prints a message for people on stderr.
func (f *Factory) Stderrf(format string, args ...any) {
	fmt.Fprintf(f.IO.ErrOut, format, args...)
}
