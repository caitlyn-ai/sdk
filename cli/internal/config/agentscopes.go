package config

import (
	"fmt"
	"sort"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

// ScopeFamilies are the areas an agent_scopes list may name, from the overlay's scope catalogue (the same list the
// sign-in's agent-scope picker shows), sorted. The api: surface scope is allowed besides these; mcp: is not, since
// the CLI's token is for the API, never the MCP server.
func ScopeFamilies() []string {
	var out []string
	for f := range spec.MustOverlay().Scopes {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

// KnownScopeFamily reports whether family is one an API token's scope can name: api, or an area in the catalogue.
func KnownScopeFamily(family string) bool {
	if family == "api" {
		return true
	}
	_, ok := spec.MustOverlay().Scopes[family]
	return ok
}

// CheckAgentScopes checks an agent_scopes setting: read-only, full or none on its own, or a list of scopes, each
// api: or a known area at read, write or admin. The error names the bad value, says what is valid and, for a close
// typo, what was probably meant.
func CheckAgentScopes(list []string) error {
	for _, s := range list {
		s = strings.TrimSpace(s)
		switch s {
		case "read-only", "full", "none":
			if len(list) > 1 {
				return fmt.Errorf("%s goes on its own, not in a list", s)
			}
			continue
		}
		fam, tier, ok := strings.Cut(s, ":")
		validTier := tier == "read" || tier == "write" || tier == "admin"
		if ok && validTier && KnownScopeFamily(fam) {
			continue
		}
		msg := fmt.Sprintf("%q is not a scope an agent can have", s)
		switch {
		case fam == "mcp":
			msg += " (mcp: scopes are for the MCP server; the CLI's token is for the API)"
		case ok && !validTier && KnownScopeFamily(fam):
			msg += fmt.Sprintf(" (did you mean %s:read?)", fam)
		default:
			if guess := closestFamily(fam); guess != "" && fam != "mcp" {
				t := tier
				if !validTier {
					t = "read"
				}
				msg += fmt.Sprintf(" (did you mean %s:%s?)", guess, t)
			}
		}
		return fmt.Errorf("%s. Use read-only, full or none, or a list of scopes, each one of %s at :read, :write or :admin", msg, strings.Join(append([]string{"api"}, ScopeFamilies()...), ", "))
	}
	return nil
}

// closestFamily is the known family nearest name by edit distance, when it is close enough to be a typo.
func closestFamily(name string) string {
	best, bestD := "", 3
	for _, f := range append([]string{"api"}, ScopeFamilies()...) {
		if d := editDistance(name, f); d < bestD {
			best, bestD = f, d
		}
	}
	return best
}

func editDistance(a, b string) int {
	prev := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur := make([]int, len(b)+1)
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(b)]
}

// checkAgentScopesIn refuses a file whose agent_scopes, at its top level or in a profile, isn't valid.
func checkAgentScopesIn(m map[string]any, path string) error {
	check := func(key string, v any) error {
		var list []string
		switch t := v.(type) {
		case string:
			list = []string{t}
		case []any:
			for _, x := range t {
				list = append(list, fmt.Sprint(x))
			}
		default:
			return nil
		}
		if err := CheckAgentScopes(list); err != nil {
			return &FileError{Path: path, Key: key, Err: err}
		}
		return nil
	}
	if v, ok := m["agent_scopes"]; ok {
		if err := check("agent_scopes", v); err != nil {
			return err
		}
	}
	profiles, _ := m["profiles"].(map[string]any)
	names := make([]string, 0, len(profiles))
	for n := range profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if p, ok := profiles[n].(map[string]any); ok {
			if v, ok := p["agent_scopes"]; ok {
				if err := check("profiles."+n+".agent_scopes", v); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
