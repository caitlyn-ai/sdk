package auth_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeOAuth is a workspace's authorisation server and GetCaller, as 17.4 describes them, plus GitHub's OIDC token
// endpoint. Refresh tokens rotate and are single-use: a reused one is refused and counted, as the real server raises
// its "was this you?" alert.
type fakeOAuth struct {
	t   *testing.T
	srv *httptest.Server
	ws  string

	mu sync.Mutex
	// expiresIn is the access tokens' lifetime in seconds.
	expiresIn int64
	// granted is what a sign-in is granted.
	granted string
	// scopeMode is how a refresh with scope is answered: "wider" (the full grant, today's server), "missing" (no scope
	// member), "honour" (the narrower scope, 17.4 item 8) or "server" (the app's rule since !2138 round 5: honoured
	// only when it can't widen the grant, else invalid_scope; see serverAllows).
	scopeMode string
	// refreshDelay widens the window two refreshes could overlap in.
	refreshDelay time.Duration
	// refuseRefresh answers every refresh with invalid_grant.
	refuseRefresh bool
	// deviceScript is the device flow's answers in turn: an OAuth error code, or "ok".
	deviceScript []string

	n            int
	codes        map[string]codeGrant
	liveRefresh  map[string]string // refresh token → its original grant
	spent        map[string]bool
	access       map[string]string // access token → scope
	authorizeQ   []url.Values
	codeExchange []url.Values
	refreshes    []url.Values
	exchanges    []url.Values
	revoked      []string
	reuse        int
	devicePolls  int
	deviceStarts []url.Values
	meBearers    []string
	ghRequests   []*http.Request
}

type codeGrant struct {
	challenge, method, redirect, scope string
}

var loopbackRE = regexp.MustCompile(`^http://127\.0\.0\.1:[1-9][0-9]*/callback$`)

func newFakeOAuth(t *testing.T, ws string) *fakeOAuth {
	f := &fakeOAuth{t: t, ws: ws, expiresIn: 3600, granted: "api:admin", scopeMode: "wider",
		codes: map[string]codeGrant{}, liveRefresh: map[string]string{}, spent: map[string]bool{}, access: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/oauth/authorize", f.authorize)
	mux.HandleFunc("/api/oauth/token", f.token)
	mux.HandleFunc("/api/oauth/device_authorization", f.device)
	mux.HandleFunc("/api/v3/me", f.me)
	mux.HandleFunc("/gh/token", f.github)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOAuth) resource() string { return "https://" + f.ws + "/api" }

func (f *fakeOAuth) oauthError(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "error_description": desc})
}

func (f *fakeOAuth) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f.mu.Lock()
	f.authorizeQ = append(f.authorizeQ, q)
	f.mu.Unlock()
	switch {
	case q.Get("client_id") != "caitlyn-cli", q.Get("response_type") != "code":
		http.Error(w, "bad client or response type", 400)
		return
	case q.Get("code_challenge_method") != "S256" || len(q.Get("code_challenge")) != 43:
		http.Error(w, "PKCE S256 is required", 400)
		return
	case q.Get("resource") != f.resource():
		http.Error(w, "bad resource "+q.Get("resource"), 400)
		return
	case !loopbackRE.MatchString(q.Get("redirect_uri")):
		http.Error(w, "redirect must be a 127.0.0.1 loopback: "+q.Get("redirect_uri"), 400)
		return
	}
	f.mu.Lock()
	f.n++
	code := fmt.Sprintf("code-%d", f.n)
	f.codes[code] = codeGrant{challenge: q.Get("code_challenge"), method: q.Get("code_challenge_method"), redirect: q.Get("redirect_uri"), scope: q.Get("scope")}
	f.mu.Unlock()
	http.Redirect(w, r, q.Get("redirect_uri")+"?code="+code+"&state="+url.QueryEscape(q.Get("state")), http.StatusFound)
}

// issue makes an access token and, when withRefresh, a refresh token; the caller holds mu.
func (f *fakeOAuth) issue(w http.ResponseWriter, scope, grant string, withRefresh bool, scopeInResponse bool) {
	f.n++
	at := fmt.Sprintf("at-%d", f.n)
	f.access[at] = scope
	body := map[string]any{"access_token": at, "token_type": "Bearer", "expires_in": f.expiresIn}
	if scopeInResponse {
		body["scope"] = scope
	}
	if withRefresh {
		rt := fmt.Sprintf("rt-%d", f.n)
		f.liveRefresh[rt] = grant
		body["refresh_token"] = rt
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func (f *fakeOAuth) token(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	_ = r.ParseForm()
	p := r.PostForm
	if p.Get("action") == "revoke" {
		f.mu.Lock()
		f.revoked = append(f.revoked, p.Get("token"))
		delete(f.liveRefresh, p.Get("token"))
		f.mu.Unlock()
		w.WriteHeader(200)
		_, _ = w.Write([]byte("{}"))
		return
	}
	switch p.Get("grant_type") {
	case "authorization_code":
		f.mu.Lock()
		defer f.mu.Unlock()
		f.codeExchange = append(f.codeExchange, p)
		g, ok := f.codes[p.Get("code")]
		delete(f.codes, p.Get("code"))
		sum := sha256.Sum256([]byte(p.Get("code_verifier")))
		switch {
		case !ok:
			f.oauthError(w, 400, "invalid_grant", "unknown or used code")
		case p.Get("client_id") != "caitlyn-cli" || p.Get("redirect_uri") != g.redirect || p.Get("resource") != f.resource():
			f.oauthError(w, 400, "invalid_grant", "client, redirect or resource differs")
		case base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge:
			f.oauthError(w, 400, "invalid_grant", "PKCE verifier doesn't match")
		default:
			f.issue(w, f.granted, f.granted, true, true)
		}
	case "refresh_token":
		if d := f.delay(); d > 0 {
			time.Sleep(d)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.refreshes = append(f.refreshes, p)
		rt := p.Get("refresh_token")
		grant, live := f.liveRefresh[rt]
		switch {
		case f.refuseRefresh:
			f.oauthError(w, 400, "invalid_grant", "refused by the test")
			return
		case f.spent[rt]:
			f.reuse++
			f.oauthError(w, 400, "invalid_grant", "refresh token reused: was this you?")
			return
		case !live:
			f.oauthError(w, 400, "invalid_grant", "unknown refresh token")
			return
		}
		delete(f.liveRefresh, rt)
		f.spent[rt] = true
		asked := p.Get("scope")
		switch {
		case asked == "":
			f.issue(w, grant, grant, true, true)
		case f.scopeMode == "honour":
			f.issue(w, asked, grant, true, true)
		case f.scopeMode == "server":
			if !serverAllows(strings.Fields(grant), strings.Fields(asked)) {
				f.oauthError(w, 400, "invalid_scope", "the requested scope is not within the grant")
				return
			}
			f.issue(w, asked, grant, true, true)
		case f.scopeMode == "missing":
			f.issue(w, grant, grant, true, false)
		default:
			f.issue(w, grant, grant, true, true)
		}
	case "urn:ietf:params:oauth:grant-type:device_code":
		f.mu.Lock()
		defer f.mu.Unlock()
		i := f.devicePolls
		f.devicePolls++
		if i >= len(f.deviceScript) {
			f.oauthError(w, 400, "expired_token", "script ran out")
			return
		}
		switch step := f.deviceScript[i]; step {
		case "ok":
			f.issue(w, f.granted, f.granted, true, true)
		default:
			f.oauthError(w, 400, step, "")
		}
	case "urn:ietf:params:oauth:grant-type:token-exchange":
		f.mu.Lock()
		defer f.mu.Unlock()
		f.exchanges = append(f.exchanges, p)
		if p.Get("resource") != f.resource() || p.Get("subject_token") == "" {
			f.oauthError(w, 400, "invalid_request", "bad exchange")
			return
		}
		f.issue(w, "api:write", "", false, true)
	default:
		f.oauthError(w, 400, "unsupported_grant_type", p.Get("grant_type"))
	}
}

func (f *fakeOAuth) delay() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.refreshDelay
}

func (f *fakeOAuth) device(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	f.mu.Lock()
	f.deviceStarts = append(f.deviceStarts, r.PostForm)
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"device_code": "dev-1", "user_code": "BCDF-GHJK", "verification_uri": "https://" + f.ws + "/device",
		"verification_uri_complete": "https://" + f.ws + "/device?user_code=BCDF-GHJK", "expires_in": 600, "interval": 5,
	})
}

func (f *fakeOAuth) me(w http.ResponseWriter, r *http.Request) {
	bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	f.mu.Lock()
	f.meBearers = append(f.meBearers, bearer)
	scope, ok := f.access[bearer]
	f.mu.Unlock()
	w.Header().Set("Caitlyn-Api-Version", "5.144.0")
	w.Header().Set("Caitlyn-Request-Id", "req-1")
	if !ok {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"type":"https://build.caitlyn.ai/errors/UNAUTHENTICATED","title":"Unauthenticated","status":401,"code":"UNAUTHENTICATED","requestId":"req-1"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"userId": "U1", "displayName": "Aroha Ngata", "credential": "oauth", "scopes": strings.Fields(scope),
		"organisation": map[string]string{"id": "O1", "name": "Example Govt"},
	})
}

func (f *fakeOAuth) github(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.ghRequests = append(f.ghRequests, r)
	f.mu.Unlock()
	if r.Header.Get("Authorization") != "bearer gh-request-token" || r.URL.Query().Get("audience") != f.resource() {
		http.Error(w, "bad request token or audience", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"count":1,"value":"gh-jwt"}`))
}

// addToken accepts a personal access token at GetCaller.
func (f *fakeOAuth) addToken(tok, scope string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.access[tok] = scope
}

// with runs fn holding the lock, to read or set the fake's state.
func (f *fakeOAuth) with(fn func(f *fakeOAuth)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

// serverAllows is the app's rule for a narrower refresh (app !2138, round 5, I1), written out here independently of
// the CLI's own, in the subset form the server judges by (narrowPermissionsToScopes of the request within that of
// the grant):
//   - a grant that is surface scopes alone (api:write, mcp:read) covers every family at its tier, and each surface
//     at its own tier;
//   - in a grant that names families, the api: scope is a ceiling: a family asked for must be granted, at no more
//     than the lower of its tier and the ceiling; a surface scope asked for must be covered by the same granted
//     surface; and the request must name at least one family (a surface scope alone means every area).
func serverAllows(grant, asked []string) bool {
	tier := map[string]int{"read": 1, "write": 2, "admin": 3}
	parse := func(s string) (string, int) {
		i := strings.LastIndexByte(s, ':')
		if i < 0 {
			return s, 0
		}
		return s[:i], tier[s[i+1:]]
	}
	surface := func(f string) bool { return f == "api" || f == "mcp" }
	families, ceiling := false, 0
	for _, g := range grant {
		f, t := parse(g)
		if t > 0 && !surface(f) {
			families = true
		}
		if f == "api" && t > ceiling {
			ceiling = t
		}
	}
	covered := func(need string) bool {
		nf, nt := parse(need)
		for _, g := range grant {
			gf, gt := parse(g)
			switch {
			case gt == 0 || nt == 0:
				if g == need {
					return true
				}
			case surface(nf):
				if gf == nf && gt >= nt {
					return true
				}
			case families:
				have := gt
				if ceiling > 0 && ceiling < have {
					have = ceiling
				}
				if gf == nf && have >= nt {
					return true
				}
			default: // surface scopes alone: each covers every family at its tier
				if (gf == nf || surface(gf)) && gt >= nt {
					return true
				}
			}
		}
		return false
	}
	askedFamily := false
	for _, a := range asked {
		f, t := parse(a)
		if t > 0 && !surface(f) {
			askedFamily = true
		}
		if !covered(a) {
			return false
		}
	}
	return !families || askedFamily
}
