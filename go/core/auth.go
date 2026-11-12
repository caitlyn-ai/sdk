package core

// Sign-in (PROTOCOL.md section 12). Every mode except Token and Session ends in the same thing: a short-lived
// Caitlyn bearer token from the workspace's token endpoint ({endpoint}/oauth/token), cached until it is due
// for renewal and renewed by one request however many calls are waiting.
//
//   Token              a personal access token, sent as it is
//   ClientCredentials  client ID and secret exchanged for a token; asked again before expiry
//   OAuth              authorisation code with PKCE, then refresh tokens; a TokenStore keeps them
//   AWSIAM             STS GetWebIdentityToken with the caller's AWS credentials, exchanged (RFC 8693)
//   WorkloadIdentity   a JWT from another trusted issuer (a GitLab CI id_tokens variable), exchanged (RFC 8693)
//   Session            the browser session cookie; Origin on every write (the Caitlyn app, local recording)

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	grantTokenExchange = "urn:ietf:params:oauth:grant-type:token-exchange"
	tokenTypeJWT       = "urn:ietf:params:oauth:token-type:jwt"
	tokenTypeAccess    = "urn:ietf:params:oauth:token-type:access_token"
	renewEarly         = time.Minute
)

// AuthError is a sign-in failure: the token endpoint's OAuth error, or a failure to get the identity it
// exchanges. It is not one of the operation errors: a 401 from an operation is UnauthenticatedError.
type AuthError struct {
	// Code is the OAuth error (invalid_client, invalid_grant…), else the body's code, else http_<status>; or
	// one the SDK raises itself: sign_in_required, invalid_state, invalid_request, aws_identity_failed, or
	// the STS error code in AWSIAM mode.
	Code string
	// Message is the error_description, else the body's detail.
	Message string
	// Status is the HTTP status, or 0 for errors the SDK raises itself.
	Status int
	// RequestID is the Caitlyn-Request-Id header.
	RequestID string
	// Cause is the underlying failure, when there is one.
	Cause error
}

func (e *AuthError) Error() string {
	s := "caitlyn: sign-in failed: " + e.Code
	if e.Message != "" {
		s += ": " + e.Message
	}
	if e.RequestID != "" {
		s += " [" + e.RequestID + "]"
	}
	return s
}

func (e *AuthError) Unwrap() error { return e.Cause }

// OAuthTokens are the tokens the OAuth mode keeps. A zero ExpiresAt means the token has no known expiry.
type OAuthTokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	Scope        string
}

// TokenStore keeps the OAuth mode's tokens between processes, for example encrypted on a server. Load
// returns nil, nil when there is nothing stored.
type TokenStore interface {
	Load(ctx context.Context) (*OAuthTokens, error)
	Save(ctx context.Context, tokens OAuthTokens) error
	Clear(ctx context.Context) error
}

// ClientCredentials signs in with a client ID and secret (a machine client).
type ClientCredentials struct {
	ClientID     string
	ClientSecret string
	Scopes       []string
	// Resource replaces the workspace audience, https://<workspace>/api.
	Resource string
}

// OAuth signs a person in with the authorisation code flow and PKCE, then renews with refresh tokens. Start
// with Client.Auth().AuthorizationURL and finish with Client.Auth().HandleCallback.
type OAuth struct {
	ClientID string
	// ClientSecret is for a confidential client on a server only.
	ClientSecret string
	RedirectURI  string
	Scopes       []string
	// Resource replaces the workspace audience, https://<workspace>/api.
	Resource string
	// TokenStore keeps the tokens. Default: in memory for the life of the client.
	TokenStore TokenStore
}

// AWSIAM signs in with AWS credentials: STS GetWebIdentityToken on the regional endpoint, then a token
// exchange of the JWT it returns. This mode, and only this mode, reads AWS_* environment variables.
type AWSIAM struct {
	// Region selects the regional STS endpoint. Default: AWS_REGION, then AWS_DEFAULT_REGION.
	Region string
	// Credentials is called at each sign-in. Default: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (with
	// AWS_SESSION_TOKEN), then the container credentials endpoint (ECS, Fargate, AgentCore). Profiles, single
	// sign-on and instance metadata are reached by passing a function, for example one that calls the AWS
	// SDK's credential chain.
	Credentials func(ctx context.Context) (AWSCredentials, error)
	// SigningAlgorithm is ES384 (the default) or RS256.
	SigningAlgorithm string
	// DurationSeconds is the AWS token's lifetime, at most 300 (the default).
	DurationSeconds int
	// Audience changes only the AWS token's audience. Default: the workspace audience.
	Audience string
	// STSEndpoint replaces https://sts.<region>.amazonaws.com/ (FIPS or VPC endpoints, tests).
	STSEndpoint string
}

// WorkloadIdentity signs in with a JWT from another trusted issuer, for example a GitLab CI id_tokens
// variable. Token is called at every sign-in: the server accepts each JWT once, so the SDK never reuses one.
type WorkloadIdentity struct {
	Token func(ctx context.Context) (string, error)
	// Resource replaces the workspace audience, https://<workspace>/api.
	Resource string
}

// Session signs in with the browser session: no Authorization header, the cookie in Cookie, and Origin on
// every request other than GET and HEAD. For the Caitlyn app itself and local recording.
type Session struct {
	Cookie string
	// Origin is sent on writes. Default: https://<workspace>.
	Origin string
}

var errUnbound = &AuthError{Code: "invalid_request", Message: "pass this sign-in mode to NewClient"}

// Authorize fails: a sign-in mode works through the client NewClient makes from it.
func (ClientCredentials) Authorize(context.Context, *http.Request) error { return errUnbound }

// Authorize fails: a sign-in mode works through the client NewClient makes from it.
func (OAuth) Authorize(context.Context, *http.Request) error { return errUnbound }

// Authorize fails: a sign-in mode works through the client NewClient makes from it.
func (AWSIAM) Authorize(context.Context, *http.Request) error { return errUnbound }

// Authorize fails: a sign-in mode works through the client NewClient makes from it.
func (WorkloadIdentity) Authorize(context.Context, *http.Request) error { return errUnbound }

// Authorize fails: a sign-in mode works through the client NewClient makes from it.
func (Session) Authorize(context.Context, *http.Request) error { return errUnbound }

// WorkspaceHost reduces a workspace given as a hostname or a URL to its hostname.
func WorkspaceHost(workspace string) string {
	host := workspace
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if i := strings.IndexByte(host, '/'); i >= 0 {
		host = host[:i]
	}
	return host
}

// WorkspaceAudience is the audience of a workspace's tokens, https://<workspace>/api.
func WorkspaceAudience(workspace string) string {
	return "https://" + WorkspaceHost(workspace) + "/api"
}

// AuthSession is a client's sign-in: the cached token and the OAuth mode's steps. Get it with Client.Auth().
type AuthSession struct {
	auth       Auth
	mode       string
	endpoint   string
	resource   string
	workspace  string
	httpClient HTTPDoer
	userAgent  string

	mu       sync.Mutex
	cached   *cachedToken
	refused  string // the token the server last refused, so OAuth never reloads it from the store
	inflight *flight
	memory   *OAuthTokens // the OAuth tokens when there is no TokenStore
}

type cachedToken struct {
	token     string
	renewAt   time.Time // zero: kept until a 401
	expiresAt time.Time
}

// flight is one token request that every waiting call shares.
type flight struct {
	done    chan struct{}
	token   string
	err     error
	waiters int
	cancel  context.CancelFunc
}

func newAuthSession(auth Auth, endpoint, workspace string, httpClient HTTPDoer, userAgent string) *AuthSession {
	s := &AuthSession{auth: auth, endpoint: endpoint, workspace: WorkspaceHost(workspace), httpClient: httpClient, userAgent: userAgent}
	s.resource = WorkspaceAudience(workspace)
	switch a := auth.(type) {
	case Token:
		s.mode = "token"
	case ClientCredentials:
		s.mode = "clientCredentials"
		if a.Resource != "" {
			s.resource = a.Resource
		}
	case OAuth:
		s.mode = "oauth"
		if a.Resource != "" {
			s.resource = a.Resource
		}
	case AWSIAM:
		s.mode = "awsIam"
	case WorkloadIdentity:
		s.mode = "workloadIdentity"
		if a.Resource != "" {
			s.resource = a.Resource
		}
	case Session:
		s.mode = "session"
	default:
		s.mode = "custom"
	}
	return s
}

// Mode is the sign-in mode: token, clientCredentials, oauth, awsIam, workloadIdentity, session, or custom
// (a TokenFunc or another Auth).
func (s *AuthSession) Mode() string { return s.mode }

// Resource is the audience every token is for: https://<workspace>/api unless the mode's Resource is set.
// An endpoint override never changes it.
func (s *AuthSession) Resource() string { return s.resource }

// TokenEndpoint is {endpoint}/oauth/token.
func (s *AuthSession) TokenEndpoint() string { return s.endpoint + "/oauth/token" }

func (s *AuthSession) renews() bool {
	switch s.mode {
	case "clientCredentials", "oauth", "awsIam", "workloadIdentity":
		return true
	}
	return false
}

// Authorize adds the credential to a request.
func (s *AuthSession) Authorize(ctx context.Context, req *http.Request) error {
	switch a := s.auth.(type) {
	case Session:
		req.Header.Del("Authorization")
		if a.Cookie != "" {
			req.Header.Set("Cookie", a.Cookie)
		}
		if req.Method != http.MethodGet && req.Method != http.MethodHead {
			origin := a.Origin
			if origin == "" {
				origin = "https://" + s.workspace
			}
			req.Header.Set("Origin", origin)
		}
		return nil
	}
	if !s.renews() {
		return s.auth.Authorize(ctx, req)
	}
	tok, err := s.Token(ctx)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	return nil
}

// Token returns the bearer token for the next request: the cached one, or a new one got by a single token
// request that every concurrent caller waits for. A caller whose context ends stops waiting; the request is
// cancelled when no caller is left waiting for it.
func (s *AuthSession) Token(ctx context.Context) (string, error) {
	if !s.renews() {
		if t, ok := s.auth.(Token); ok {
			return string(t), nil
		}
		return "", &AuthError{Code: "invalid_request", Message: "no token to fetch in " + s.mode + " mode"}
	}
	s.mu.Lock()
	if c := s.cached; c != nil && (c.renewAt.IsZero() || time.Now().Before(c.renewAt)) {
		s.mu.Unlock()
		return c.token, nil
	}
	f := s.inflight
	if f == nil {
		fctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		f = &flight{done: make(chan struct{}), cancel: cancel}
		s.inflight = f
		go func() {
			tok, err := s.fetchToken(fctx)
			s.mu.Lock()
			if s.inflight == f {
				s.inflight = nil
			}
			f.token, f.err = tok, err
			s.mu.Unlock()
			cancel()
			close(f.done)
		}()
	}
	f.waiters++
	s.mu.Unlock()
	select {
	case <-f.done:
		return f.token, f.err
	case <-ctx.Done():
		s.mu.Lock()
		f.waiters--
		if f.waiters == 0 {
			f.cancel()
			if s.inflight == f {
				s.inflight = nil
			}
		}
		s.mu.Unlock()
		return "", ctx.Err()
	}
}

// invalidate forgets the cached token after the server refused sent, so the next call signs in again. A
// token renewed meanwhile by another call is kept.
func (s *AuthSession) invalidate(sent string) {
	tok := strings.TrimPrefix(sent, "Bearer ")
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refused = tok
	if s.cached != nil && s.cached.token == tok {
		s.cached = nil
	}
}

func (s *AuthSession) setCached(t OAuthTokens) {
	s.mu.Lock()
	s.cached = cacheEntry(t)
	s.mu.Unlock()
}

// cacheEntry decides when a token is due: a minute before it expires, or halfway through a life shorter
// than two minutes (measured when it arrives). A token with no expiry is kept until a 401.
func cacheEntry(t OAuthTokens) *cachedToken {
	c := &cachedToken{token: t.AccessToken, expiresAt: t.ExpiresAt}
	if !t.ExpiresAt.IsZero() {
		early := renewEarly
		if half := time.Until(t.ExpiresAt) / 2; half < early {
			early = half
		}
		c.renewAt = t.ExpiresAt.Add(-early)
	}
	return c
}

func (s *AuthSession) fetchToken(ctx context.Context) (string, error) {
	var (
		t   OAuthTokens
		err error
	)
	switch a := s.auth.(type) {
	case ClientCredentials:
		p := url.Values{"grant_type": {"client_credentials"}, "resource": {s.resource}}
		addClient(p, a.ClientID, a.ClientSecret)
		if len(a.Scopes) > 0 {
			p.Set("scope", strings.Join(a.Scopes, " "))
		}
		t, err = s.requestToken(ctx, p)
	case OAuth:
		return s.oauthToken(ctx, a)
	case AWSIAM:
		var subject string
		subject, err = s.awsIdentityToken(ctx, a)
		if err == nil {
			t, err = s.exchange(ctx, subject)
		}
	case WorkloadIdentity:
		if a.Token == nil {
			return "", &AuthError{Code: "invalid_request", Message: "workloadIdentity: Token is required"}
		}
		var subject string
		subject, err = a.Token(ctx)
		if err == nil {
			t, err = s.exchange(ctx, subject)
		}
	}
	if err != nil {
		return "", err
	}
	s.setCached(t)
	return t.AccessToken, nil
}

func (s *AuthSession) exchange(ctx context.Context, subject string) (OAuthTokens, error) {
	return s.requestToken(ctx, url.Values{
		"grant_type":           {grantTokenExchange},
		"subject_token":        {subject},
		"subject_token_type":   {tokenTypeJWT},
		"requested_token_type": {tokenTypeAccess},
		"resource":             {s.resource},
	})
}

func addClient(p url.Values, id, secret string) {
	if id != "" {
		p.Set("client_id", id)
	}
	if secret != "" {
		p.Set("client_secret", secret)
	}
}

// requestToken POSTs a form to the token endpoint and reads the tokens, or the sign-in error.
func (s *AuthSession) requestToken(ctx context.Context, p url.Values) (OAuthTokens, error) {
	resp, err := s.postForm(ctx, p)
	if err != nil {
		return OAuthTokens{}, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var body struct {
		AccessToken      *string `json:"access_token"`
		RefreshToken     string  `json:"refresh_token"`
		ExpiresIn        *int64  `json:"expires_in"`
		Scope            string  `json:"scope"`
		Error            string  `json:"error"`
		Code             string  `json:"code"`
		ErrorDescription string  `json:"error_description"`
		Detail           string  `json:"detail"`
	}
	_ = json.Unmarshal(b, &body)
	if resp.StatusCode < 200 || resp.StatusCode > 299 || body.AccessToken == nil {
		code := body.Error
		if code == "" {
			code = body.Code
		}
		if code == "" {
			code = fmt.Sprintf("http_%d", resp.StatusCode)
		}
		msg := body.ErrorDescription
		if msg == "" {
			msg = body.Detail
		}
		return OAuthTokens{}, &AuthError{Code: code, Message: msg, Status: resp.StatusCode, RequestID: resp.Header.Get("Caitlyn-Request-Id")}
	}
	t := OAuthTokens{AccessToken: *body.AccessToken, RefreshToken: body.RefreshToken, Scope: body.Scope}
	if body.ExpiresIn != nil {
		t.ExpiresAt = time.Now().Add(time.Duration(*body.ExpiresIn) * time.Second)
	}
	return t, nil
}

func (s *AuthSession) postForm(ctx context.Context, p url.Values) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.TokenEndpoint(), strings.NewReader(p.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", s.userAgent)
	resp, err := s.httpClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &AuthError{Code: "token_request_failed", Message: err.Error(), Cause: err}
	}
	return resp, nil
}

// ------------------------------------------------------------------ oauth

// AuthorizationRequest is the start of an OAuth sign-in: the URL to send the person to, and the state and
// PKCE verifier to keep until the callback.
type AuthorizationRequest struct {
	URL          string
	State        string
	CodeVerifier string
}

// AuthorizationOptions overrides the OAuth mode's settings for one sign-in.
type AuthorizationOptions struct {
	// State is random unless given.
	State       string
	Scopes      []string
	RedirectURI string
}

// Callback is what the redirect brought back, with what the caller kept from AuthorizationURL.
type Callback struct {
	Code  string
	State string
	// ExpectedState, when set, must equal State, or the callback fails with invalid_state before any request.
	ExpectedState string
	CodeVerifier  string
	RedirectURI   string
}

func (s *AuthSession) oauth() (OAuth, error) {
	o, ok := s.auth.(OAuth)
	if !ok {
		return OAuth{}, &AuthError{Code: "invalid_request", Message: "this client signs in with " + s.mode + ", not oauth"}
	}
	return o, nil
}

// AuthorizationURL starts an OAuth sign-in (PKCE with S256).
func (s *AuthSession) AuthorizationURL(_ context.Context, opts AuthorizationOptions) (*AuthorizationRequest, error) {
	o, err := s.oauth()
	if err != nil {
		return nil, err
	}
	redirect := opts.RedirectURI
	if redirect == "" {
		redirect = o.RedirectURI
	}
	if redirect == "" {
		return nil, &AuthError{Code: "invalid_request", Message: "oauth: RedirectURI is required"}
	}
	verifier := randomString(48)
	state := opts.State
	if state == "" {
		state = randomString(16)
	}
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {o.ClientID},
		"redirect_uri":          {redirect},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"},
		"state":                 {state},
		"resource":              {s.resource},
	}
	scopes := opts.Scopes
	if scopes == nil {
		scopes = o.Scopes
	}
	if len(scopes) > 0 {
		q.Set("scope", strings.Join(scopes, " "))
	}
	return &AuthorizationRequest{URL: s.endpoint + "/oauth/authorize?" + q.Encode(), State: state, CodeVerifier: verifier}, nil
}

// HandleCallback finishes an OAuth sign-in: checks the state, exchanges the code and saves the tokens.
func (s *AuthSession) HandleCallback(ctx context.Context, cb Callback) (*OAuthTokens, error) {
	o, err := s.oauth()
	if err != nil {
		return nil, err
	}
	if cb.ExpectedState != "" && cb.State != cb.ExpectedState {
		return nil, &AuthError{Code: "invalid_state", Message: "oauth: the state does not match"}
	}
	redirect := cb.RedirectURI
	if redirect == "" {
		redirect = o.RedirectURI
	}
	p := url.Values{"grant_type": {"authorization_code"}, "code": {cb.Code}, "code_verifier": {cb.CodeVerifier}, "resource": {s.resource}}
	if redirect != "" {
		p.Set("redirect_uri", redirect)
	}
	addClient(p, o.ClientID, o.ClientSecret)
	t, err := s.requestToken(ctx, p)
	if err != nil {
		return nil, err
	}
	if err := s.saveTokens(ctx, o, t); err != nil {
		return nil, err
	}
	return &t, nil
}

// SignOut revokes the refresh token where it can (a failure is ignored), then clears the cached token and
// the token store.
func (s *AuthSession) SignOut(ctx context.Context) error {
	o, err := s.oauth()
	if err != nil {
		return err
	}
	t, err := s.loadTokens(ctx, o)
	if err != nil {
		return err
	}
	if t != nil && t.RefreshToken != "" {
		p := url.Values{"action": {"revoke"}, "token": {t.RefreshToken}}
		addClient(p, o.ClientID, o.ClientSecret)
		if resp, err := s.postForm(ctx, p); err == nil {
			resp.Body.Close()
		}
	}
	s.mu.Lock()
	s.cached, s.memory = nil, nil
	s.mu.Unlock()
	if o.TokenStore != nil {
		return o.TokenStore.Clear(ctx)
	}
	return nil
}

func (s *AuthSession) loadTokens(ctx context.Context, o OAuth) (*OAuthTokens, error) {
	if o.TokenStore != nil {
		return o.TokenStore.Load(ctx)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.memory, nil
}

func (s *AuthSession) saveTokens(ctx context.Context, o OAuth, t OAuthTokens) error {
	s.mu.Lock()
	saved := t
	s.memory = &saved
	s.cached = cacheEntry(t)
	s.mu.Unlock()
	if o.TokenStore != nil {
		return o.TokenStore.Save(ctx, t)
	}
	return nil
}

// oauthToken uses a stored access token that is good for more than a minute and is not the one this client
// holds or saw refused (another process signed in or refreshed); otherwise it refreshes.
func (s *AuthSession) oauthToken(ctx context.Context, o OAuth) (string, error) {
	stored, err := s.loadTokens(ctx, o)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	held := s.refused
	if s.cached != nil {
		held = s.cached.token
	}
	s.mu.Unlock()
	switch {
	case stored != nil && (stored.ExpiresAt.IsZero() || time.Until(stored.ExpiresAt) > renewEarly) && stored.AccessToken != held:
		s.setCached(*stored)
		return stored.AccessToken, nil
	case stored != nil && stored.RefreshToken != "":
		p := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {stored.RefreshToken}}
		addClient(p, o.ClientID, o.ClientSecret)
		t, err := s.requestToken(ctx, p)
		if err != nil {
			var ae *AuthError
			if errors.As(err, &ae) && ae.Code == "invalid_grant" {
				s.mu.Lock()
				s.memory, s.cached = nil, nil
				s.mu.Unlock()
				if o.TokenStore != nil {
					_ = o.TokenStore.Clear(ctx)
				}
			}
			return "", err
		}
		if t.RefreshToken == "" {
			t.RefreshToken = stored.RefreshToken
		}
		if err := s.saveTokens(ctx, o, t); err != nil {
			return "", err
		}
		return t.AccessToken, nil
	default:
		return "", &AuthError{Code: "sign_in_required", Message: "oauth: not signed in. Call Auth().AuthorizationURL and Auth().HandleCallback first"}
	}
}

func randomString(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// readAllString reads a body up to 1 MiB.
func readAllString(r io.Reader) string {
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(io.LimitReader(r, 1<<20))
	return buf.String()
}
