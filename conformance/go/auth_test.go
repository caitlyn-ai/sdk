package conformance

// Sign-in (PROTOCOL.md section 12), against the mock server's OAuth endpoints and STS stand-in
// (conformance/mock-server/auth.mjs). Each case turns on the mock's `require` fault, so every /v3/ request
// needs a credential the mock issued or accepts. The cases join the protocol map, so TestProtocol runs them
// as TestProtocol/auth.<case>.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/caitlyn-ai/caitlyn-go"
)

// The values conformance/mock-server/auth.mjs accepts.
const (
	mockClientID      = "machine-client"
	mockClientSecret  = "machine-secret"
	mockOAuthClient   = "studio-client"
	mockOAuthSecret   = "studio-secret"
	mockAWSKeyID      = "AKIDMOCKCAITLYN"
	mockAWSSecret     = "mock-secret-key"
	mockAWSRegion     = "ap-southeast-2"
	mockPAT           = "pat_test"
	mockSessionCookie = "caitlyn_session=mock-session"
	workspace         = "your-company.getcaitlyn.ai"
	// resource is the audience: it comes from the workspace, never from the endpoint override these cases use.
	resource    = "https://your-company.getcaitlyn.ai/api"
	redirectURI = "https://app.example.com/callback"
)

func signInRequired(t *testing.T, m mock) {
	m.faults(t, map[string]any{"auth": map[string]any{"require": true}})
}

func authFaults(t *testing.T, m mock, f map[string]any) { m.faults(t, map[string]any{"auth": f}) }

func authCounts(t *testing.T, m mock) map[string]int {
	t.Helper()
	resp, err := http.Get(m.base + "/__mock/auth")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Counts map[string]int `json:"counts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Counts
}

func tokenRequests(t *testing.T, m mock) []url.Values {
	var out []url.Values
	for _, r := range m.matching(t, func(r logged) bool { return r.Path == "/oauth/token" }) {
		form, _ := url.ParseQuery(r.Body)
		out = append(out, form)
	}
	return out
}

func signedIn(t *testing.T, m mock, auth caitlyn.Auth, ws ...string) *caitlyn.Client {
	t.Helper()
	w := workspace
	if len(ws) > 0 {
		w = ws[0]
	}
	c, err := caitlyn.NewClient(w, auth, caitlyn.WithEndpoint(m.base))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func read(c *caitlyn.Client) (*caitlyn.AgentVersion, error) {
	return c.Versions.Get(context.Background(), &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
}

func mustRead(t *testing.T, c *caitlyn.Client) *caitlyn.AgentVersion {
	t.Helper()
	v, err := read(c)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// readConcurrently makes n calls at once and fails on any error.
func readConcurrently(t *testing.T, c *caitlyn.Client, n int) {
	t.Helper()
	errs := make(chan error, n)
	for range n {
		go func() { _, err := read(c); errs <- err }()
	}
	for range n {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}

// authError returns err as *caitlyn.AuthError, failing the test otherwise.
func authError(t *testing.T, err error) *caitlyn.AuthError {
	t.Helper()
	var e *caitlyn.AuthError
	if !errors.As(err, &e) {
		t.Fatalf("want *caitlyn.AuthError, got %T: %v", err, err)
	}
	return e
}

func unauthenticated(t *testing.T, err error) {
	t.Helper()
	var e *caitlyn.UnauthenticatedError
	if !errors.As(err, &e) || e.Status != 401 || e.Code != "UNAUTHENTICATED" {
		t.Fatalf("want a 401 UnauthenticatedError, got %T: %v", err, err)
	}
}

func cc(scopes ...string) caitlyn.ClientCredentials {
	return caitlyn.ClientCredentials{ClientID: mockClientID, ClientSecret: mockClientSecret, Scopes: scopes}
}

// memoryStore is a TokenStore a test can look into.
type memoryStore struct {
	mu     sync.Mutex
	tokens *caitlyn.OAuthTokens
	clears int
}

func (s *memoryStore) Load(context.Context) (*caitlyn.OAuthTokens, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tokens == nil {
		return nil, nil
	}
	t := *s.tokens
	return &t, nil
}

func (s *memoryStore) Save(_ context.Context, t caitlyn.OAuthTokens) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens = &t
	return nil
}

func (s *memoryStore) Clear(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens = nil
	s.clears++
	return nil
}

func (s *memoryStore) get() *caitlyn.OAuthTokens {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokens
}

// oauthSignIn runs the OAuth sign-in steps, following the mock's redirect as a browser would, and returns the
// authorisation URL.
func oauthSignIn(t *testing.T, c *caitlyn.Client) *url.URL {
	t.Helper()
	ctx := context.Background()
	start, err := c.Auth().AuthorizationURL(ctx, caitlyn.AuthorizationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	browser := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := browser.Get(start.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	redirect, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || redirect.Query().Get("code") == "" {
		t.Fatalf("redirect %q: %v", resp.Header.Get("Location"), err)
	}
	q := redirect.Query()
	if _, err := c.Auth().HandleCallback(ctx, caitlyn.Callback{Code: q.Get("code"), State: q.Get("state"), ExpectedState: start.State, CodeVerifier: start.CodeVerifier}); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(start.URL)
	return u
}

func oauthMode(store caitlyn.TokenStore) caitlyn.OAuth {
	return caitlyn.OAuth{ClientID: mockOAuthClient, RedirectURI: redirectURI, TokenStore: store}
}

func awsMode() caitlyn.AWSIAM {
	return caitlyn.AWSIAM{
		Region:      mockAWSRegion,
		STSEndpoint: server.base + "/__sts/",
		Credentials: func(context.Context) (caitlyn.AWSCredentials, error) {
			return caitlyn.AWSCredentials{AccessKeyID: mockAWSKeyID, SecretAccessKey: mockAWSSecret, SessionToken: "session-token"}, nil
		},
	}
}

// mockOIDCToken is a workload identity token as GitLab CI would mint it (unsigned: the mock reads the claims).
func mockOIDCToken(aud string) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	jti := make([]byte, 16)
	rand.Read(jti)
	now := time.Now().Unix()
	return enc(map[string]string{"alg": "none", "typ": "JWT"}) + "." + enc(map[string]any{
		"iss": "https://git.example.com", "sub": "project_path:group/project:ref_type:branch:ref:main",
		"aud": aud, "iat": now, "exp": now + 300, "jti": hex.EncodeToString(jti),
	}) + ".mock"
}

func workload(token func() string) caitlyn.WorkloadIdentity {
	return caitlyn.WorkloadIdentity{Token: func(context.Context) (string, error) { return token(), nil }}
}

func init() {
	for id, run := range authCases {
		protocol[id] = run
	}
}

var authCases = map[string]func(t *testing.T, m mock){
	"auth.workspace": func(t *testing.T, m mock) {
		signInRequired(t, m)
		// A workspace given as a URL is reduced to its hostname.
		mustRead(t, signedIn(t, m, cc(), "https://your-company.getcaitlyn.ai/"))
		forms := tokenRequests(t, m)
		if len(forms) != 1 || forms[0].Get("resource") != resource || len(m.api(t)) != 1 {
			t.Fatalf("token requests %v, %d API requests", forms, len(m.api(t)))
		}
		// Without an endpoint override, the workspace sets the endpoint and the audience alike.
		c, err := caitlyn.NewClient("https://your-company.getcaitlyn.ai/", cc())
		if err != nil || c.Endpoint() != "https://your-company.getcaitlyn.ai/api" || c.Auth().Resource() != resource ||
			c.Auth().TokenEndpoint() != "https://your-company.getcaitlyn.ai/api/oauth/token" {
			t.Fatalf("endpoint %q audience %q err %v", c.Endpoint(), c.Auth().Resource(), err)
		}
	},
	"auth.token": func(t *testing.T, m mock) {
		signInRequired(t, m)
		mustRead(t, signedIn(t, m, caitlyn.Token(mockPAT)))
		if got := m.api(t)[0].Headers["authorization"]; got != "Bearer "+mockPAT {
			t.Fatalf("authorization %q", got)
		}
		if n := authCounts(t, m); len(n) != 1 || n["sts"] != 0 || len(tokenRequests(t, m)) != 0 {
			t.Fatalf("counts %v", n)
		}
	},
	"auth.client-credentials": func(t *testing.T, m mock) {
		signInRequired(t, m)
		c := signedIn(t, m, cc("agents:read"))
		readConcurrently(t, c, 3)
		mustRead(t, c)
		if n := authCounts(t, m)["client_credentials"]; n != 1 {
			t.Fatalf("%d token requests, want 1", n)
		}
		auths := map[string]bool{}
		for _, r := range m.api(t) {
			auths[r.Headers["authorization"]] = true
		}
		for a := range auths {
			if len(auths) != 1 || !strings.HasPrefix(a, "Bearer cai_cc_") {
				t.Fatalf("authorizations %v", auths)
			}
		}
		f := tokenRequests(t, m)[0]
		if f.Get("client_id") != mockClientID || f.Get("resource") != resource || f.Get("scope") != "agents:read" {
			t.Fatalf("token request %v", f)
		}
	},
	"auth.client-credentials-refused": func(t *testing.T, m mock) {
		signInRequired(t, m)
		_, err := read(signedIn(t, m, caitlyn.ClientCredentials{ClientID: mockClientID, ClientSecret: "wrong"}))
		if e := authError(t, err); e.Code != "invalid_client" || e.Status != 401 || len(m.api(t)) != 0 {
			t.Fatalf("got %+v, %d API requests", e, len(m.api(t)))
		}
	},
	"auth.renew-before-expiry": func(t *testing.T, m mock) {
		authFaults(t, m, map[string]any{"require": true, "expiresIn": 1})
		c := signedIn(t, m, cc())
		mustRead(t, c)
		mustRead(t, c)
		if n := authCounts(t, m)["client_credentials"]; n != 1 {
			t.Fatalf("%d token requests within the first half of the token's life, want 1", n)
		}
		time.Sleep(600 * time.Millisecond)
		mustRead(t, c)
		if n := authCounts(t, m)["client_credentials"]; n != 2 || len(m.api(t)) != 3 {
			t.Fatalf("%d token requests after half its life (want 2), %d API requests (want 3: none refused)", n, len(m.api(t)))
		}
	},
	"auth.401-signs-in-again": func(t *testing.T, m mock) {
		signInRequired(t, m)
		c := signedIn(t, m, cc())
		mustRead(t, c)
		authFaults(t, m, map[string]any{"revokeIssued": true})
		v := mustRead(t, c)
		if v.AgentID != agent || authCounts(t, m)["client_credentials"] != 2 || len(m.api(t)) != 3 {
			t.Fatalf("agent %q, %d token requests, %d API requests (want the first call, the refused attempt and the one after signing in again)",
				v.AgentID, authCounts(t, m)["client_credentials"], len(m.api(t)))
		}
	},
	"auth.401-once": func(t *testing.T, m mock) {
		signInRequired(t, m)
		c := signedIn(t, m, cc())
		mustRead(t, c)
		// From here every token the mock issues expires at once, so the new token is refused too.
		authFaults(t, m, map[string]any{"revokeIssued": true, "expiresIn": 0})
		_, err := read(c)
		unauthenticated(t, err)
		if n := authCounts(t, m)["client_credentials"]; n != 2 || len(m.api(t)) != 3 {
			t.Fatalf("%d token requests (want 2), %d API requests (want 3)", n, len(m.api(t)))
		}
	},
	"auth.401-token-mode": func(t *testing.T, m mock) {
		signInRequired(t, m)
		_, err := read(signedIn(t, m, caitlyn.Token("pat_revoked")))
		unauthenticated(t, err)
		if len(m.api(t)) != 1 {
			t.Fatalf("%d API requests, want 1", len(m.api(t)))
		}
	},
	"auth.oauth-sign-in": func(t *testing.T, m mock) {
		signInRequired(t, m)
		store := &memoryStore{}
		c := signedIn(t, m, caitlyn.OAuth{ClientID: mockOAuthClient, ClientSecret: mockOAuthSecret, RedirectURI: redirectURI, Scopes: []string{"chat:write"}, TokenStore: store})
		u := oauthSignIn(t, c)
		q := u.Query()
		if u.Path != "/oauth/authorize" || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" ||
			q.Get("resource") != resource || q.Get("scope") != "chat:write" {
			t.Fatalf("authorisation URL %s", u)
		}
		f := tokenRequests(t, m)[0]
		if f.Get("grant_type") != "authorization_code" || f.Get("resource") != resource || f.Get("client_secret") != mockOAuthSecret {
			t.Fatalf("token request %v", f)
		}
		if s := store.get(); s == nil || s.RefreshToken == "" {
			t.Fatalf("stored %+v", s)
		}
		mustRead(t, c)
		if a := m.api(t)[0].Headers["authorization"]; !strings.HasPrefix(a, "Bearer cai_code_") {
			t.Fatalf("authorization %q", a)
		}
	},
	"auth.oauth-state": func(t *testing.T, m mock) {
		signInRequired(t, m)
		c := signedIn(t, m, caitlyn.OAuth{ClientID: mockOAuthClient, RedirectURI: redirectURI})
		_, err := c.Auth().HandleCallback(context.Background(), caitlyn.Callback{Code: "x", State: "forged", ExpectedState: "expected", CodeVerifier: "v"})
		if e := authError(t, err); e.Code != "invalid_state" || len(tokenRequests(t, m)) != 0 {
			t.Fatalf("got %+v, %d token requests", e, len(tokenRequests(t, m)))
		}
	},
	"auth.oauth-refresh": func(t *testing.T, m mock) {
		signInRequired(t, m)
		store := &memoryStore{}
		oauthSignIn(t, signedIn(t, m, oauthMode(store)))
		first := store.get().RefreshToken
		// A new process with an expired access token in the store.
		expired := *store.get()
		expired.ExpiresAt = time.Now().Add(-time.Millisecond)
		store.Save(context.Background(), expired)
		later := signedIn(t, m, caitlyn.OAuth{ClientID: mockOAuthClient, TokenStore: store})
		readConcurrently(t, later, 2)
		if n := authCounts(t, m)["refresh_token"]; n != 1 {
			t.Fatalf("%d refreshes, want one however many calls wait", n)
		}
		api := m.api(t)
		if store.get().RefreshToken == first || !strings.HasPrefix(api[len(api)-1].Headers["authorization"], "Bearer cai_refresh_") {
			t.Fatalf("refresh token not rotated, or sent %q", api[len(api)-1].Headers["authorization"])
		}
	},
	"auth.oauth-401-refreshes": func(t *testing.T, m mock) {
		signInRequired(t, m)
		store := &memoryStore{}
		c := signedIn(t, m, oauthMode(store))
		oauthSignIn(t, c)
		mustRead(t, c)
		authFaults(t, m, map[string]any{"revokeIssued": true})
		mustRead(t, c)
		var sent []string
		for _, r := range m.api(t) {
			sent = append(sent, r.Headers["authorization"])
		}
		if n := authCounts(t, m)["refresh_token"]; n != 1 || len(sent) != 3 || sent[1] != sent[0] || !strings.HasPrefix(sent[2], "Bearer cai_refresh_") {
			t.Fatalf("%d refreshes, sent %v (want the token, the refused token again once, then the refreshed one)", n, sent)
		}
	},
	"auth.oauth-refresh-refused": func(t *testing.T, m mock) {
		signInRequired(t, m)
		store := &memoryStore{tokens: &caitlyn.OAuthTokens{AccessToken: "old", RefreshToken: "rt_unknown", ExpiresAt: time.Now().Add(-time.Millisecond)}}
		_, err := read(signedIn(t, m, caitlyn.OAuth{ClientID: mockOAuthClient, TokenStore: store}))
		if e := authError(t, err); e.Code != "invalid_grant" || store.get() != nil || store.clears != 1 || len(m.api(t)) != 0 {
			t.Fatalf("got %+v, stored %+v, %d clears, %d API requests", e, store.get(), store.clears, len(m.api(t)))
		}
	},
	"auth.oauth-not-signed-in": func(t *testing.T, m mock) {
		signInRequired(t, m)
		_, err := read(signedIn(t, m, caitlyn.OAuth{ClientID: mockOAuthClient}))
		if e := authError(t, err); e.Code != "sign_in_required" || len(m.requests(t)) != 0 {
			t.Fatalf("got %+v, %d requests", e, len(m.requests(t)))
		}
	},
	"auth.aws-iam": func(t *testing.T, m mock) {
		signInRequired(t, m)
		readConcurrently(t, signedIn(t, m, awsMode()), 2)
		n := authCounts(t, m)
		if n["sts"] != 1 || n["urn:ietf:params:oauth:grant-type:token-exchange"] != 1 {
			t.Fatalf("counts %v, want one STS call and one exchange", n)
		}
		if a := m.api(t)[0].Headers["authorization"]; !strings.HasPrefix(a, "Bearer cai_x_aws_") {
			t.Fatalf("authorization %q", a)
		}
		sts, _ := url.ParseQuery(m.matching(t, func(r logged) bool { return r.Path == "/__sts/" })[0].Body)
		if sts.Get("Action") != "GetWebIdentityToken" || sts.Get("Audience.member.1") != resource || sts.Get("SigningAlgorithm") != "ES384" || sts.Get("DurationSeconds") != "300" {
			t.Fatalf("STS request %v", sts)
		}
		f := tokenRequests(t, m)[0]
		if f.Get("subject_token_type") != "urn:ietf:params:oauth:token-type:jwt" || f.Get("resource") != resource {
			t.Fatalf("token request %v", f)
		}
	},
	"auth.aws-iam-provider": func(t *testing.T, m mock) {
		signInRequired(t, m)
		calls := 0
		a := awsMode()
		a.Credentials = func(context.Context) (caitlyn.AWSCredentials, error) {
			calls++
			return caitlyn.AWSCredentials{AccessKeyID: mockAWSKeyID, SecretAccessKey: mockAWSSecret}, nil
		}
		mustRead(t, signedIn(t, m, a))
		if calls != 1 || authCounts(t, m)["sts"] != 1 {
			t.Fatalf("provider asked %d times, %d STS calls", calls, authCounts(t, m)["sts"])
		}
	},
	"auth.aws-iam-env": func(t *testing.T, m mock) {
		signInRequired(t, m)
		t.Setenv("AWS_ACCESS_KEY_ID", mockAWSKeyID)
		t.Setenv("AWS_SECRET_ACCESS_KEY", mockAWSSecret)
		t.Setenv("AWS_SESSION_TOKEN", "")
		t.Setenv("AWS_REGION", mockAWSRegion)
		mustRead(t, signedIn(t, m, caitlyn.AWSIAM{STSEndpoint: m.base + "/__sts/"}))
		if n := authCounts(t, m)["sts"]; n != 1 {
			t.Fatalf("%d STS calls", n)
		}
	},
	"auth.aws-iam-bad-signature": func(t *testing.T, m mock) {
		signInRequired(t, m)
		a := awsMode()
		a.Credentials = func(context.Context) (caitlyn.AWSCredentials, error) {
			return caitlyn.AWSCredentials{AccessKeyID: mockAWSKeyID, SecretAccessKey: "wrong"}, nil
		}
		_, err := read(signedIn(t, m, a))
		if e := authError(t, err); e.Code != "SignatureDoesNotMatch" || e.Status != 403 || len(m.api(t)) != 0 {
			t.Fatalf("got %+v, %d API requests", e, len(m.api(t)))
		}
	},
	"auth.aws-iam-no-credentials": func(t *testing.T, m mock) {
		signInRequired(t, m)
		for _, k := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"} {
			t.Setenv(k, "")
		}
		a := awsMode()
		a.Credentials = nil
		_, err := read(signedIn(t, m, a))
		if e := authError(t, err); e.Code != "aws_identity_failed" || len(m.requests(t)) != 0 {
			t.Fatalf("got %+v, %d requests", e, len(m.requests(t)))
		}
	},
	"auth.workload-identity": func(t *testing.T, m mock) {
		signInRequired(t, m)
		asked := 0
		mustRead(t, signedIn(t, m, workload(func() string { asked++; return mockOIDCToken(resource) })))
		if a := m.api(t)[0].Headers["authorization"]; asked != 1 || !strings.HasPrefix(a, "Bearer cai_x_oidc_") {
			t.Fatalf("asked %d times, authorization %q", asked, a)
		}
		_, err := read(signedIn(t, m, workload(func() string { return mockOIDCToken("https://other.getcaitlyn.ai/api") })))
		if e := authError(t, err); e.Code != "invalid_grant" {
			t.Fatalf("a token for another workspace: got %+v", e)
		}
	},
	"auth.workload-identity-single-use": func(t *testing.T, m mock) {
		signInRequired(t, m)
		jwt := mockOIDCToken(resource)
		mustRead(t, signedIn(t, m, workload(func() string { return jwt })))
		_, err := read(signedIn(t, m, workload(func() string { return jwt })))
		if e := authError(t, err); e.Code != "invalid_grant" {
			t.Fatalf("a replayed token: got %+v", e)
		}
	},
	"auth.session": func(t *testing.T, m mock) {
		signInRequired(t, m)
		c := signedIn(t, m, caitlyn.Session{Cookie: mockSessionCookie, Origin: "https://caitlyn.lndo.site"})
		v := mustRead(t, c)
		if _, err := c.Versions.UpdateDraft(context.Background(), agent, &caitlyn.UpdateDraftVersionInput{Instructions: caitlyn.Ptr("Cite clause numbers.")}, caitlyn.WithIfMatch(v.ETag)); err != nil {
			t.Fatal(err)
		}
		api := m.api(t)
		get, patch := api[0].Headers, api[1].Headers
		if get["authorization"] != "" || get["cookie"] != mockSessionCookie || get["origin"] != "" ||
			patch["origin"] != "https://caitlyn.lndo.site" || patch["authorization"] != "" || len(tokenRequests(t, m)) != 0 {
			t.Fatalf("GET %v PATCH %v", get, patch)
		}
	},
}

// ------------------------------------------------------------------ Go only

// TestGoSignInCancelled: a caller whose context ends stops waiting for the shared token request, and the
// other callers still get the token.
func TestGoSignInCancelled(t *testing.T) {
	m := fresh(t)
	signInRequired(t, m)
	release := make(chan struct{})
	c := signedIn(t, m, caitlyn.WorkloadIdentity{Token: func(ctx context.Context) (string, error) {
		select {
		case <-release:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		return mockOIDCToken(resource), nil
	}})
	ctx, cancel := context.WithCancel(context.Background())
	cancelled := make(chan error, 1)
	go func() {
		_, err := c.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agent, Version: "draft"})
		cancelled <- err
	}()
	waiting := make(chan error, 1)
	go func() { _, err := read(c); waiting <- err }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-cancelled; !errors.Is(err, context.Canceled) {
		t.Fatalf("the cancelled call returned %v", err)
	}
	close(release)
	if err := <-waiting; err != nil {
		t.Fatalf("the waiting call failed: %v", err)
	}
	if n := authCounts(t, m)["urn:ietf:params:oauth:grant-type:token-exchange"]; n != 1 {
		t.Fatalf("%d exchanges, want 1", n)
	}
}

// TestGoSignInModeOutsideClient: a sign-in mode used directly as an Auth fails rather than sending nothing.
func TestGoSignInModeOutsideClient(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://example.com", nil)
	if e := authError(t, cc().Authorize(context.Background(), req)); e.Code != "invalid_request" {
		t.Fatalf("got %+v", e)
	}
	c, _ := caitlyn.NewClient(workspace, caitlyn.Token(mockPAT))
	_, err := c.Auth().AuthorizationURL(context.Background(), caitlyn.AuthorizationOptions{})
	if e := authError(t, err); e.Code != "invalid_request" {
		t.Fatalf("an OAuth step on a token client: got %+v", e)
	}
}
