package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/gofrs/flock"
	"github.com/zalando/go-keyring"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/go/core"
)

// keyringService is the service name every keychain item is filed under. The item's account is its key:
// caitlyn:<workspace>:<profile> for the person's tokens, and agent.CacheKey for an agent's access token (18.5).
const keyringService = "caitlyn-cli"

// Entry is what the CLI keeps for one key: the person's OAuth tokens, a personal access token saved by
// `auth login --with-token`, or an AI agent's narrower access token.
type Entry struct {
	// Kind is oauth, token (a personal access token) or agent.
	Kind         string    `json:"kind"`
	AccessToken  string    `json:"access_token,omitempty"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
	// Scope is the scopes granted, space-separated: the token response's scope, else what was asked for.
	Scope string `json:"scope,omitempty"`
	// AgentKey (on the person's entry) names the agent token cached last, so a change of agent_scopes deletes it.
	AgentKey string `json:"agent_key,omitempty"`
	// Narrowed (on an agent's entry) is true when the server issued a token limited to the scopes asked for.
	Narrowed bool `json:"narrowed,omitempty"`
}

// Scopes splits Scope.
func (e *Entry) Scopes() []string { return strings.Fields(e.Scope) }

// Fresh reports whether the access token is good for more than a minute (or has no known expiry).
func (e *Entry) Fresh(now time.Time) bool {
	return e.AccessToken != "" && (e.ExpiresAt.IsZero() || e.ExpiresAt.Sub(now) > renewEarly)
}

// renewEarly is how long before expiry an access token is renewed, as the SDK does.
const renewEarly = time.Minute

// errNotFound is a key with nothing stored.
var errNotFound = errors.New("not stored")

// backend is where entries are kept: the operating system's keychain, or the insecure file.
type backend interface {
	// Name describes the storage for people: "macOS Keychain", "~/.caitlyn/credentials".
	Name() string
	Insecure() bool
	get(key string) (string, error)
	set(key, value string) error
	del(key string) error
	// probe checks that the storage can be used, before anyone is asked to sign in.
	probe() error
}

// keychain stores entries through go-keyring: the macOS Keychain, Windows Credential Manager or the Secret Service.
type keychain struct{}

func (keychain) Name() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS Keychain"
	case "windows":
		return "Windows Credential Manager"
	}
	return "the Secret Service keyring"
}

func (keychain) Insecure() bool { return false }

func (k keychain) get(key string) (string, error) {
	v, err := keyring.Get(keyringService, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", errNotFound
	}
	if err != nil {
		return "", k.unavailable(err)
	}
	return v, nil
}

func (k keychain) set(key, value string) error {
	if err := keyring.Set(keyringService, key, value); err != nil {
		return k.unavailable(err)
	}
	return nil
}

func (k keychain) del(key string) error {
	err := keyring.Delete(keyringService, key)
	if err == nil || errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return k.unavailable(err)
}

func (k keychain) probe() error {
	_, err := k.get("caitlyn:probe")
	if errors.Is(err, errNotFound) {
		return nil
	}
	return err
}

func (k keychain) unavailable(err error) error {
	e := &cmdutil.Error{Exit: exitcode.Failed, Code: "KEYCHAIN_UNAVAILABLE", Cause: err,
		Title:  "The keychain can't be used, so there is nowhere safe to keep your sign-in.",
		Detail: fmt.Sprintf("%s: %v. Start a keyring service, or opt in to keeping tokens in a file only you can read.", k.Name(), err)}
	e.AddNext("caitlyn auth login --insecure-storage", "keep tokens in ~/.caitlyn/credentials (mode 0600) instead; auth status says so every time")
	return e
}

// credentialsFile stores entries in ~/.caitlyn/credentials, mode 0600, chosen only with --insecure-storage.
type credentialsFile struct {
	path string
	// display is the path as people see it.
	display string
}

func (c credentialsFile) Name() string   { return c.display }
func (c credentialsFile) Insecure() bool { return true }
func (c credentialsFile) probe() error   { return nil }

func (c credentialsFile) read() (map[string]json.RawMessage, error) {
	b, err := os.ReadFile(c.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s could not be read: %w", c.display, err)
	}
	m := map[string]json.RawMessage{}
	if len(strings.TrimSpace(string(b))) == 0 {
		return m, nil
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s is not valid: %w (sign in again to replace it)", c.display, err)
	}
	return m, nil
}

func (c credentialsFile) get(key string) (string, error) {
	m, err := c.read()
	if err != nil {
		return "", err
	}
	v, ok := m[key]
	if !ok {
		return "", errNotFound
	}
	// A value is kept as a JSON string (a token); an entry written before the tokens were split is an object
	var str string
	if json.Unmarshal(v, &str) == nil {
		return str, nil
	}
	return string(v), nil
}

// update changes the file under its own lock, since several profiles share it.
func (c credentialsFile) update(fn func(m map[string]json.RawMessage)) error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	l := flock.New(filepath.Join(filepath.Dir(c.path), ".lock-credentials"))
	if err := l.Lock(); err != nil {
		return fmt.Errorf("the credentials file's lock could not be taken: %w", err)
	}
	defer func() { _ = l.Unlock() }()
	m, err := c.read()
	if err != nil {
		return err
	}
	fn(m)
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	// WriteFile keeps an existing file's mode; make sure no one else can read it whatever it was
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

func (c credentialsFile) set(key, value string) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return c.update(func(m map[string]json.RawMessage) { m[key] = json.RawMessage(b) })
}

func (c credentialsFile) del(key string) error {
	return c.update(func(m map[string]json.RawMessage) { delete(m, key) })
}

// The store's lock is the SDK's: the OAuth handling here and the SDK's own OAuth mode honour the same contract.
var _ core.TokenStoreLocker = (*Store)(nil)

// Store keeps one profile's entries, and the profile's lock.
type Store struct {
	b         backend
	lockPath  string
	Workspace string
	Profile   string
}

// newStore opens the storage for a profile: the keychain, or the credentials file when insecure.
func newStore(dir, home, workspace, profile string, insecure bool) *Store {
	var b backend = keychain{}
	if insecure {
		b = credentialsFile{path: filepath.Join(dir, "credentials"), display: displayPath(dir, home, "credentials")}
	}
	return &Store{b: b, lockPath: filepath.Join(dir, ".lock-"+safeName(profile)), Workspace: workspace, Profile: profile}
}

func displayPath(dir, home, name string) string {
	if home != "" && strings.HasPrefix(dir, filepath.Clean(home)+string(filepath.Separator)) {
		return "~" + strings.TrimPrefix(filepath.Join(dir, name), filepath.Clean(home))
	}
	return filepath.Join(dir, name)
}

var unsafeChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func safeName(s string) string { return unsafeChars.ReplaceAllString(s, "_") }

// StorageName describes where the tokens are kept.
func (s *Store) StorageName() string { return s.b.Name() }

// Insecure reports whether the tokens are in the credentials file rather than the keychain.
func (s *Store) Insecure() bool { return s.b.Insecure() }

// PersonKey is the key of the person's own tokens.
func (s *Store) PersonKey() string { return "caitlyn:" + s.Workspace + ":" + s.Profile }

// Each entry is kept as up to three items: the entry itself (kind, expiry, scopes), its access token, and its refresh
// token. Windows Credential Manager holds at most 2,560 bytes an item, and an access token (a JWT) and a refresh
// token together can pass that; one token at a time fits.
const (
	accessSuffix  = ":access"
	refreshSuffix = ":refresh"
)

// Load reads an entry; nil when nothing is stored.
func (s *Store) Load(key string) (*Entry, error) {
	v, err := s.b.get(key)
	if errors.Is(err, errNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var e Entry
	if err := json.Unmarshal([]byte(v), &e); err != nil {
		// an entry that can't be read is as good as none: sign-in replaces it
		return nil, nil
	}
	// An entry written before the tokens were split keeps them inline; read them from their own items otherwise
	if e.AccessToken == "" {
		if t, err := s.b.get(key + accessSuffix); err == nil {
			e.AccessToken = t
		} else if !errors.Is(err, errNotFound) {
			return nil, err
		}
	}
	if e.RefreshToken == "" {
		if t, err := s.b.get(key + refreshSuffix); err == nil {
			e.RefreshToken = t
		} else if !errors.Is(err, errNotFound) {
			return nil, err
		}
	}
	return &e, nil
}

// Save writes an entry: the tokens first, each in its own item, then the entry that names them.
func (s *Store) Save(key string, e *Entry) error {
	meta := *e
	meta.AccessToken, meta.RefreshToken = "", ""
	for suffix, tok := range map[string]string{accessSuffix: e.AccessToken, refreshSuffix: e.RefreshToken} {
		var err error
		if tok == "" {
			err = s.b.del(key + suffix)
		} else {
			err = s.b.set(key+suffix, tok)
		}
		if err != nil {
			return err
		}
	}
	b, err := json.Marshal(&meta)
	if err != nil {
		return err
	}
	return s.b.set(key, string(b))
}

// Delete removes an entry and its tokens; removing a missing one is not an error.
func (s *Store) Delete(key string) error {
	for _, k := range []string{key + accessSuffix, key + refreshSuffix, key} {
		if err := s.b.del(k); err != nil {
			return err
		}
	}
	return nil
}

// WithLock runs fn holding the profile's exclusive file lock (~/.caitlyn/.lock-<profile>), so two processes never
// send the same single-use refresh token: the second waits, then loads what the first saved (5.2). It implements
// the SDK's core.TokenStoreLocker.
func (s *Store) WithLock(ctx context.Context, fn func(ctx context.Context) error) error {
	if err := os.MkdirAll(filepath.Dir(s.lockPath), 0o700); err != nil {
		return err
	}
	l := flock.New(s.lockPath)
	ok, err := l.TryLockContext(ctx, 25*time.Millisecond)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("the sign-in lock %s could not be taken: %w", s.lockPath, err)
	}
	if !ok {
		return ctx.Err()
	}
	defer func() { _ = l.Unlock() }()
	return fn(ctx)
}
