// Package skew remembers the last Caitlyn release each profile's workspace reported (Caitlyn-Api-Version), so the
// first command of a session can already refuse an operation the workspace doesn't have yet, and help and `caitlyn
// version` can say which commands need a newer release (the CLI design, 8.2).
package skew

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Seen is a workspace's release as last seen.
type Seen struct {
	Version string    `json:"version"`
	At      time.Time `json:"at"`
}

func path(dir, profile string) string {
	return filepath.Join(dir, "cache", "server-"+safe(profile)+".json")
}

func safe(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, s)
}

// Load reads what was last seen for the profile, or nil.
func Load(dir, profile string) *Seen {
	b, err := os.ReadFile(path(dir, profile))
	if err != nil {
		return nil
	}
	var s Seen
	if json.Unmarshal(b, &s) != nil || s.Version == "" {
		return nil
	}
	return &s
}

// Save records a version the workspace reported. Writing only when it changed keeps every command from touching the
// disk.
func Save(dir, profile, version string, now time.Time) {
	if prev := Load(dir, profile); prev != nil && prev.Version == version && now.Sub(prev.At) < time.Hour {
		return
	}
	p := path(dir, profile)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return
	}
	b, _ := json.Marshal(Seen{Version: version, At: now})
	tmp := p + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, p)
	}
}

// Compare compares two release versions numerically (5.140.2 < 5.144.0). Anything that isn't a number sorts as 0;
// "next" (an unreleased operation) is newer than every release.
func Compare(a, b string) int {
	if a == b {
		return 0
	}
	if a == "next" {
		return 1
	}
	if b == "next" {
		return -1
	}
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < max(len(as), len(bs)); i++ {
		var x, y int
		if i < len(as) {
			x, _ = strconv.Atoi(strings.SplitN(as[i], "-", 2)[0])
		}
		if i < len(bs) {
			y, _ = strconv.Atoi(strings.SplitN(bs[i], "-", 2)[0])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}
