package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/caitlyn-ai/sdk/go/core"
)

// ClientID is the CLI's built-in public OAuth client, present in every workspace (17.4, item 1).
const ClientID = "caitlyn-cli"

// The CLI's own OAuth handling. The SDK's OAuth mode has no scope on refresh, which agent scopes need (18.5), so the
// CLI does the code exchange, refresh with rotation, device grant and revocation itself, and hands the clients a
// core.TokenFunc. The wire format follows the SDK's (go/core/auth.go), so the two can merge later.

// oauthClient talks to one workspace's authorisation server.
type oauthClient struct {
	// Endpoint is the API's base URL, https://<workspace>/api unless the profile overrides it.
	Endpoint string
	// Resource is the RFC 8707 resource, always https://<workspace>/api: an endpoint override never changes it.
	Resource  string
	HTTP      *http.Client
	UserAgent string
	Now       func() time.Time
}

func newOAuthClient(workspace, endpoint string, hc *http.Client, userAgent string, now func() time.Time) *oauthClient {
	if endpoint == "" {
		endpoint = core.WorkspaceEndpoint(workspace)
	}
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	if now == nil {
		now = time.Now
	}
	return &oauthClient{Endpoint: strings.TrimRight(endpoint, "/"), Resource: core.WorkspaceAudience(workspace), HTTP: hc, UserAgent: userAgent, Now: now}
}

func (c *oauthClient) authorizeURL() string { return c.Endpoint + "/oauth/authorize" }
func (c *oauthClient) tokenURL() string     { return c.Endpoint + "/oauth/token" }
func (c *oauthClient) deviceURL() string    { return c.Endpoint + "/oauth/device_authorization" }

// pkce is an RFC 7636 verifier and its S256 challenge.
type pkce struct {
	Verifier, Challenge string
}

func newPKCE() pkce {
	v := randomString(32) // 43 characters, the minimum RFC 7636 allows, from 256 random bits
	sum := sha256.Sum256([]byte(v))
	return pkce{Verifier: v, Challenge: base64.RawURLEncoding.EncodeToString(sum[:])}
}

func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("caitlyn: no randomness: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// tokenResponse is a token endpoint's answer, success or error (RFC 6749 5.1 and 5.2, RFC 8628 3.5).
type tokenResponse struct {
	AccessToken      string  `json:"access_token"`
	RefreshToken     string  `json:"refresh_token"`
	ExpiresIn        *int64  `json:"expires_in"`
	Scope            *string `json:"scope"`
	Error            string  `json:"error"`
	Code             string  `json:"code"`
	ErrorDescription string  `json:"error_description"`
	Detail           string  `json:"detail"`
}

// granted is what a token response says about its tokens. ScopeGiven is false when the response had no scope.
type granted struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	Scope        string
	ScopeGiven   bool
}

// postForm sends a form to url and decodes the JSON answer into out. A non-2xx answer is a *core.AuthError.
func (c *oauthClient) postForm(ctx context.Context, u string, form url.Values, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, &core.AuthError{Code: "token_request_failed", Message: "the workspace could not be reached: " + err.Error(), Cause: err}
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if out != nil {
		_ = json.Unmarshal(b, out)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var body tokenResponse
		_ = json.Unmarshal(b, &body)
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
		return resp.StatusCode, &core.AuthError{Code: code, Message: msg, Status: resp.StatusCode, RequestID: resp.Header.Get("Caitlyn-Request-Id")}
	}
	return resp.StatusCode, nil
}

// token asks the token endpoint for tokens.
func (c *oauthClient) token(ctx context.Context, form url.Values) (*granted, error) {
	var body tokenResponse
	if _, err := c.postForm(ctx, c.tokenURL(), form, &body); err != nil {
		return nil, err
	}
	if body.AccessToken == "" {
		return nil, &core.AuthError{Code: "invalid_response", Message: "the token endpoint returned no access token"}
	}
	g := &granted{AccessToken: body.AccessToken, RefreshToken: body.RefreshToken}
	if body.ExpiresIn != nil {
		g.ExpiresAt = c.Now().Add(time.Duration(*body.ExpiresIn) * time.Second)
	}
	if body.Scope != nil {
		g.Scope, g.ScopeGiven = strings.TrimSpace(*body.Scope), true
	}
	return g, nil
}

// authorizationURL is the browser's first stop: authorisation code with PKCE S256 and the RFC 8707 resource.
func (c *oauthClient) authorizationURL(redirectURI, state string, p pkce, scopes []string) string {
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {ClientID},
		"redirect_uri":          {redirectURI},
		"code_challenge":        {p.Challenge},
		"code_challenge_method": {"S256"},
		"state":                 {state},
		"resource":              {c.Resource},
	}
	if len(scopes) > 0 {
		q.Set("scope", strings.Join(scopes, " "))
	}
	return c.authorizeURL() + "?" + q.Encode()
}

// exchangeCode swaps the authorisation code for tokens.
func (c *oauthClient) exchangeCode(ctx context.Context, code, redirectURI string, p pkce) (*granted, error) {
	return c.token(ctx, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {ClientID},
		"code_verifier": {p.Verifier},
		"resource":      {c.Resource},
	})
}

// refresh renews with a refresh token. scopes, when given, asks for a narrower access token (RFC 6749 section 6):
// agent mode. The refresh token rotates either way.
func (c *oauthClient) refresh(ctx context.Context, refreshToken string, scopes []string) (*granted, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {ClientID},
		"resource":      {c.Resource},
	}
	if scopes != nil {
		form.Set("scope", strings.Join(scopes, " "))
	}
	return c.token(ctx, form)
}

// revoke revokes a refresh token, as the SDK's SignOut does.
func (c *oauthClient) revoke(ctx context.Context, refreshToken string) error {
	form := url.Values{"action": {"revoke"}, "token": {refreshToken}, "token_type_hint": {"refresh_token"}, "client_id": {ClientID}}
	_, err := c.postForm(ctx, c.tokenURL(), form, nil)
	return err
}
