package auth

import (
	"context"
	"time"
)

// KeyringService is the keychain service the tests read entries from.
const KeyringService = keyringService

// SetOpenBrowser replaces how the browser is opened; the returned function restores it.
func SetOpenBrowser(fn func(ctx context.Context, browser, url string) error) func() {
	old := openBrowser
	openBrowser = fn
	return func() { openBrowser = old }
}

// SetRunCommand replaces how buildkite-agent is run; the returned function restores it.
func SetRunCommand(fn func(ctx context.Context, name string, args ...string) ([]byte, int, error)) func() {
	old := runCommand
	runCommand = fn
	return func() { runCommand = old }
}

// PersonTokenFunc is the token function a person's command in its own process would use: its own in-memory state,
// the shared store and lock. insecure selects the credentials file, which, unlike go-keyring's mock, holds no
// in-memory state for the race detector to see shared between the two "processes".
func PersonTokenFunc(dir, endpoint, workspace, profile string, insecure bool) func(context.Context) (string, error) {
	s := &session{store: newStore(dir, "", workspace, profile, insecure), oc: newOAuthClient(workspace, endpoint, nil, "test", nil), now: time.Now}
	return s.Token
}

// Backend is a token storage the tests supply, to check limits such as Windows Credential Manager's 2,560 bytes an
// item.
type Backend interface {
	Get(key string) (string, bool)
	Set(key, value string) error
	Del(key string)
}

type testBackend struct{ b Backend }

func (t testBackend) Name() string   { return "test storage" }
func (t testBackend) Insecure() bool { return false }
func (t testBackend) probe() error   { return nil }
func (t testBackend) get(key string) (string, error) {
	if v, ok := t.b.Get(key); ok {
		return v, nil
	}
	return "", errNotFound
}
func (t testBackend) set(key, value string) error { return t.b.Set(key, value) }
func (t testBackend) del(key string) error        { t.b.Del(key); return nil }

// NewStoreOn opens a store on a test backend.
func NewStoreOn(b Backend, dir, workspace, profile string) *Store {
	s := newStore(dir, "", workspace, profile, false)
	s.b = testBackend{b}
	return s
}
