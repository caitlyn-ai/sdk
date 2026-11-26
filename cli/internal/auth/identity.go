package auth

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
)

// The signed-in name is remembered per profile, so the welcome screen can say who is signed in without calling
// Caitlyn (19.5). It holds a display name only: nothing secret.

func identityPath(dir, profile string) string {
	return filepath.Join(dir, "cache", "identity-"+safeName(profile)+".json")
}

func saveIdentity(dir, profile, name string) {
	if CachedIdentity(dir, profile) == name {
		return
	}
	p := identityPath(dir, profile)
	if os.MkdirAll(filepath.Dir(p), 0o700) != nil {
		return
	}
	b, _ := json.Marshal(map[string]string{"displayName": name})
	_ = os.WriteFile(p, b, 0o600)
}

func forgetIdentity(dir, profile string) { _ = os.Remove(identityPath(dir, profile)) }

// CachedIdentity is the name GetCaller last gave for the profile, or "".
func CachedIdentity(dir, profile string) string {
	b, err := os.ReadFile(identityPath(dir, profile))
	if err != nil {
		return ""
	}
	var v struct {
		DisplayName string `json:"displayName"`
	}
	_ = json.Unmarshal(b, &v)
	return v.DisplayName
}

// WelcomeIdentity is the welcome screen's detail line: the workspace and who is signed in, from the cache.
func WelcomeIdentity(f *cmdutil.Factory) string {
	cfg, err := f.Config()
	if err != nil || cfg == nil || cfg.String("workspace") == "" {
		return "Not signed in yet: caitlyn auth login"
	}
	ws := cfg.String("workspace")
	if name := CachedIdentity(cfg.Dir(), cfg.Profile()); name != "" {
		return ws + " · signed in as " + name
	}
	return ws + " · profile " + cfg.Profile()
}
