package auth_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/auth"
)

// credentialManager is Windows Credential Manager's limit: at most 2,560 bytes an item.
type credentialManager struct{ items map[string]string }

func (c *credentialManager) Get(k string) (string, bool) { v, ok := c.items[k]; return v, ok }
func (c *credentialManager) Set(k, v string) error {
	if len(v) > 2560 {
		return fmt.Errorf("the data passed to Set was too big (%d bytes)", len(v))
	}
	c.items[k] = v
	return nil
}
func (c *credentialManager) Del(k string) { delete(c.items, k) }

// A realistic access token with many scopes and claims is about 2.4 KB, and a refresh token about 600 bytes: kept
// together they pass the limit, so each is an item of its own.
func TestTokensFitWindowsCredentialManager(t *testing.T) {
	cm := &credentialManager{items: map[string]string{}}
	s := auth.NewStoreOn(cm, t.TempDir(), "acme.caitlyn.ai", "default")
	jwt := "eyJhbGciOiJFUzI1NiIsImtpZCI6ImNhaXRseW4tMjAyNiJ9." + strings.Repeat("Q", 2300) + "." + strings.Repeat("s", 86)
	refresh := "cait-rt-" + strings.Repeat("r", 600)
	e := &auth.Entry{Kind: "oauth", AccessToken: jwt, RefreshToken: refresh, ExpiresAt: time.Now().Add(time.Hour), Scope: "api:admin agents:write knowledge-bases:write chat:write"}
	if err := s.Save(s.PersonKey(), e); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := s.Load(s.PersonKey())
	if err != nil || got == nil || got.AccessToken != jwt || got.RefreshToken != refresh || got.Scope != e.Scope {
		t.Fatalf("load: %v %+v", err, got)
	}
	if len(cm.items) != 3 {
		t.Fatalf("three items (entry, access, refresh), got %d", len(cm.items))
	}
	// a refresh token that goes away (an agent's entry has none) removes its item
	got.RefreshToken = ""
	if err := s.Save(s.PersonKey(), got); err != nil {
		t.Fatal(err)
	}
	if len(cm.items) != 2 {
		t.Fatalf("the refresh item should be gone, %d items", len(cm.items))
	}
	if err := s.Delete(s.PersonKey()); err != nil || len(cm.items) != 0 {
		t.Fatalf("delete leaves %d items: %v", len(cm.items), err)
	}
}
