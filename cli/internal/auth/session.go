package auth

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/go/core"
)

// session is the OAuth mode in use for one run: it hands out the access token, refreshing under the profile's lock.
//
// For a person it uses the person's own access token. In agent mode it uses an access token asked for with the
// narrower agent scopes on the same refresh token, cached under its own key, and never the person's (18.5).
type session struct {
	store *Store
	oc    *oauthClient
	now   func() time.Time
	// agentScopes, when not nil, makes this an agent's session: the scopes its token asks for.
	agentScopes []string
	agentKey    string
	// info is updated with what a refresh learns (whether the server narrowed the agent's token).
	info *cmdutil.AuthInfo

	mu  sync.Mutex
	cur *Entry
}

// Token is the core.TokenFunc the clients call before each request.
func (s *session) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil && s.cur.Fresh(s.now()) {
		return s.cur.AccessToken, nil
	}
	var e *Entry
	err := s.store.WithLock(ctx, func(ctx context.Context) error {
		var err error
		if s.agentScopes != nil {
			e, err = s.agentToken(ctx)
		} else {
			e, err = s.personToken(ctx)
		}
		return err
	})
	if err != nil {
		return "", err
	}
	s.cur = e
	return e.AccessToken, nil
}

// Current is the entry in use, after Token.
func (s *session) Current() *Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur
}

// personToken uses the stored access token while it is fresh (another process may have refreshed it while this one
// waited for the lock), and otherwise refreshes, saving the rotated refresh token before anything else.
func (s *session) personToken(ctx context.Context) (*Entry, error) {
	p, err := s.store.Load(s.store.PersonKey())
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, signInRequired(s.store, "Not signed in.")
	}
	if p.Kind == "token" || p.Fresh(s.now()) {
		return p, nil
	}
	if p.RefreshToken == "" {
		return nil, signInRequired(s.store, "Your sign-in has expired.")
	}
	g, err := s.oc.refresh(ctx, p.RefreshToken, nil)
	if err != nil {
		return nil, s.refreshFailed(ctx, p, err)
	}
	p.AccessToken, p.ExpiresAt = g.AccessToken, g.ExpiresAt
	if g.RefreshToken != "" {
		p.RefreshToken = g.RefreshToken
	}
	if g.ScopeGiven && g.Scope != "" {
		p.Scope = g.Scope
	}
	if err := s.store.Save(s.store.PersonKey(), p); err != nil {
		return nil, err
	}
	return p, nil
}

// agentToken uses the agent's cached access token while it is fresh, and otherwise refreshes the shared refresh token
// with scope=<agent scopes>. The person's entry keeps its own access token and gains the rotated refresh token; a
// failed refresh is an error, never a reason to use the person's token.
func (s *session) agentToken(ctx context.Context) (*Entry, error) {
	a, err := s.store.Load(s.agentKey)
	if err != nil {
		return nil, err
	}
	if a != nil && a.Fresh(s.now()) {
		s.setNarrowed(a.Narrowed)
		return a, nil
	}
	p, err := s.store.Load(s.store.PersonKey())
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, signInRequired(s.store, "Not signed in.")
	}
	if p.RefreshToken == "" {
		return nil, signInRequired(s.store, "Your sign-in has expired.")
	}
	g, err := s.oc.refresh(ctx, p.RefreshToken, s.agentScopes)
	if err != nil {
		var ae *core.AuthError
		if errors.As(err, &ae) && ae.Code == "invalid_scope" {
			e := &cmdutil.Error{Exit: exitcode.Forbidden, Code: "AGENT_SCOPE_DENIED", Cause: err,
				Title:  "The workspace refused this profile's agent scopes.",
				Detail: "It won't issue a token for " + strings.Join(s.agentScopes, " ") + " from this sign-in. " + ae.Message}
			e.AddNext("caitlyn config set agent_scopes read-only --profile "+s.store.Profile, "the person can choose agent scopes within the sign-in (only a person can change this)")
			return nil, e
		}
		return nil, s.refreshFailed(ctx, p, err)
	}
	// The rotated refresh token first: the old one is spent
	if g.RefreshToken != "" {
		p.RefreshToken = g.RefreshToken
	}
	old := p.AgentKey
	p.AgentKey = s.agentKey
	if err := s.store.Save(s.store.PersonKey(), p); err != nil {
		return nil, err
	}
	if old != "" && old != s.agentKey {
		// agent_scopes changed: the old agent token is never used again
		_ = s.store.Delete(old)
	}
	a = &Entry{Kind: "agent", AccessToken: g.AccessToken, ExpiresAt: g.ExpiresAt, Scope: g.Scope, Narrowed: narrowed(g, s.agentScopes)}
	if err := s.store.Save(s.agentKey, a); err != nil {
		return nil, err
	}
	s.setNarrowed(a.Narrowed)
	return a, nil
}

// narrowed reports whether the server honoured the narrower scope: the response names its scopes, and each is within
// what was asked for. Today's server leaves scope out or returns the full grant (17.4, item 8).
func narrowed(g *granted, asked []string) bool {
	if !g.ScopeGiven || g.Scope == "" {
		return false
	}
	for _, s := range strings.Fields(g.Scope) {
		// a scope asked for exactly (full asks for the grant as it is, its api: ceiling included), or one the request
		// covers, judged as a whole
		if !slices.Contains(asked, s) && !agent.AnyCovers(asked, s) {
			return false
		}
	}
	return true
}

func (s *session) setNarrowed(v bool) {
	if s.info != nil {
		s.info.ServerNarrowed = v
	}
}

// refreshFailed clears a refresh token the server no longer accepts, so the next command says to sign in rather than
// sending it again.
func (s *session) refreshFailed(_ context.Context, p *Entry, err error) error {
	var ae *core.AuthError
	if errors.As(err, &ae) && ae.Code == "invalid_grant" {
		if p.AgentKey != "" {
			_ = s.store.Delete(p.AgentKey)
		}
		_ = s.store.Delete(s.store.PersonKey())
		e := signInRequired(s.store, "Your sign-in has ended.")
		e.Code = "invalid_grant"
		e.Detail = "The workspace no longer accepts this profile's refresh token: it was revoked, it expired, or it was used elsewhere. " + ae.Message
		e.Cause = err
		return e
	}
	return err
}

// signInRequired is exit 4 with the command that signs this profile in again.
func signInRequired(st *Store, title string) *cmdutil.Error {
	e := &cmdutil.Error{Exit: exitcode.Auth, Code: "sign_in_required", Title: title}
	e.Detail = "No usable sign-in for " + st.Workspace + " (profile " + st.Profile + ")."
	e.AddNext(loginCommand(st.Workspace, st.Profile), "sign in")
	return e
}

// loginCommand is the complete command that signs a profile in.
func loginCommand(workspace, profile string) string {
	cmd := "caitlyn auth login"
	if workspace != "" {
		cmd += " --workspace " + workspace
	}
	if profile != "" && profile != "default" {
		cmd += " --profile " + profile
	}
	return cmd
}
