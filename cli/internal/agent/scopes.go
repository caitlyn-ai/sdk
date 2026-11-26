package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/config"
)

// The agent-scope presets (18.5).
const (
	ReadOnly = "read-only"
	Full     = "full"
	None     = "none"
)

var tiers = map[string]int{"read": 1, "write": 2, "admin": 3}

// Covers reports whether one granted scope, on its own, covers a needed one. Tiers nest (admin covers write covers
// read), and the api: surface scope covers every family at its tier. That holds only for a grant that is the surface
// scope alone: in a grant that also names families, the surface scope is a ceiling, not breadth. AnyCovers judges a
// whole grant (or setting) that way, and Effective reads a setting the same way (withinCeiling), so use them, not
// Covers, against a set of scopes.
func Covers(granted, needed string) bool {
	gf, gt := split(granted)
	nf, nt := split(needed)
	if tiers[gt] == 0 || tiers[nt] == 0 {
		return granted == needed
	}
	if gf == "api" && !config.KnownScopeFamily(nf) {
		return false // api: covers api: and the known areas, never mcp: or a family that doesn't exist
	}
	if gf != "api" && gf != nf {
		return false
	}
	return tiers[gt] >= tiers[nt]
}

func split(s string) (family, tier string) {
	i := strings.LastIndexByte(s, ':')
	if i < 0 {
		return s, ""
	}
	return s[:i], s[i+1:]
}

// isSurface: a scope that names a surface (the whole API, or MCP) rather than an area.
func isSurface(family string) bool { return family == "api" || family == "mcp" }

// namesFamilies reports whether a grant names areas (agents:write, knowledge-bases:read, ...), not only a surface.
func namesFamilies(scopes []string) bool {
	for _, s := range scopes {
		if f, t := split(s); tiers[t] > 0 && !isSurface(f) {
			return true
		}
	}
	return false
}

// AnyCovers reports whether a grant (or an agent's allowed scopes) covers needed, as the server judges it:
//   - a grant that is a surface scope alone (api:read) covers every family at its tier, and that surface at its tier;
//   - a grant that names families (agents:write knowledge-bases:read api:write) covers those families only, each up
//     to the lower of its own tier and the surface scope's (the ceiling), and never a surface scope: api:read on its
//     own means every area, which such a grant doesn't hold.
func AnyCovers(scopes []string, needed string) bool {
	if !namesFamilies(scopes) {
		for _, s := range scopes {
			if Covers(s, needed) {
				return true
			}
		}
		return false
	}
	nf, nt := split(needed)
	if tiers[nt] == 0 {
		for _, s := range scopes {
			if s == needed {
				return true
			}
		}
		return false
	}
	if isSurface(nf) {
		return false
	}
	ceiling := surfaceCeiling(scopes)
	for _, s := range scopes {
		f, t := split(s)
		if f != nf || tiers[t] == 0 {
			continue
		}
		have := tiers[t]
		if ceiling > 0 && ceiling < have {
			have = ceiling
		}
		if have >= tiers[nt] {
			return true
		}
	}
	return false
}

// families are a grant's areas, each at the lower of its own tier, the surface ceiling and tier.
func families(granted []string, tier string) []string {
	ceiling := surfaceCeiling(granted)
	var out []string
	for _, g := range granted {
		f, t := split(g)
		if tiers[t] == 0 || isSurface(f) {
			continue
		}
		have := min(tiers[t], tiers[tier])
		if ceiling > 0 {
			have = min(have, ceiling)
		}
		out = append(out, f+":"+tierNames[have])
	}
	return out
}

var tierNames = map[int]string{1: "read", 2: "write", 3: "admin"}

// surfaceCeiling is the api: scope's tier in a grant, or 0 when it names none.
func surfaceCeiling(granted []string) int {
	c := 0
	for _, s := range granted {
		if f, t := split(s); f == "api" && tiers[t] > c {
			c = tiers[t]
		}
	}
	return c
}

// Effective turns an agent_scopes setting into the scopes an agent's token asks for, never more than the profile's
// own grant. granted may be nil when unknown: the setting is then taken as it is.
//   - read-only is api:read: against a bare surface grant, that is what's asked for; against a grant that names areas
//     it is each granted area at read (agents:read knowledge-bases:read), since the server refuses api:read on its own
//     there: it means every area, which such a grant doesn't hold.
//   - full is the grant exactly, so the server sees no narrowing; readOnly caps it at read as below.
//   - none is nothing.
//   - a list is those scopes, each kept only where the grant covers it. A list that names areas and a surface scope
//     too (agents:write api:read, which StricterAgentScopes makes from read-only and a chosen list) means those areas
//     up to the surface scope's tier: the areas are capped by it and the surface scope is dropped, so it never
//     widens the list to every area. A list that is only a surface scope stands for the whole setting, as read-only.
//
// readOnly (the profile's read_only, or CAITLYN_READ_ONLY) caps every scope at read.
func Effective(setting []string, granted []string, readOnly bool) []string {
	var want []string
	switch {
	case len(setting) == 0 || (len(setting) == 1 && setting[0] == ReadOnly):
		want = []string{"api:read"}
	case len(setting) == 1 && setting[0] == Full:
		want = append(want, granted...)
		if len(want) == 0 {
			want = []string{"api:admin"}
		}
		if !readOnly {
			sort.Strings(want)
			return dedupe(want)
		}
	case len(setting) == 1 && setting[0] == None:
		return []string{}
	default:
		want = append(want, setting...)
	}
	if readOnly {
		var capped []string
		for _, s := range want {
			f, t := split(s)
			if tiers[t] > 1 {
				s = f + ":read"
			}
			capped = append(capped, s)
		}
		want = capped
	}
	want = withinCeiling(want)
	if granted != nil {
		var kept []string
		fams := namesFamilies(granted)
		for _, s := range want {
			f, t := split(s)
			switch {
			case fams && isSurface(f) && tiers[t] > 0:
				// only a surface scope is left (want names no area): against a grant of areas, each granted area
				// at that tier
				kept = append(kept, families(granted, t)...)
			case AnyCovers(granted, s):
				kept = append(kept, s)
			}
		}
		want = kept
	}
	want = dedupe(want)
	if want == nil {
		want = []string{}
	}
	sort.Strings(want)
	return want
}

// withinCeiling reads a setting as the server reads a grant: when it names areas, its surface scope is a ceiling, so
// each area is capped at the surface scope's tier and the surface scope is dropped (agents:write api:read is
// agents:read). A setting with no area is returned as it is.
func withinCeiling(want []string) []string {
	if !namesFamilies(want) {
		return want
	}
	ceiling := surfaceCeiling(want)
	var out []string
	for _, s := range want {
		f, t := split(s)
		switch {
		case tiers[t] > 0 && isSurface(f):
			continue
		case tiers[t] > 0 && ceiling > 0 && tiers[t] > ceiling:
			s = f + ":" + tierNames[ceiling]
		}
		out = append(out, s)
	}
	return out
}

func dedupe(l []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range l {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// CacheKey names the agent's access token in the keychain: one per profile and scope set, so a person's command never
// uses an agent's token, and a change to agent_scopes leaves the old token unused (18.5).
func CacheKey(workspace, profile string, scopes []string) string {
	s := append([]string(nil), scopes...)
	sort.Strings(s)
	h := sha256.Sum256([]byte(strings.Join(s, " ")))
	return "caitlyn:" + workspace + ":" + profile + ":agent:" + hex.EncodeToString(h[:6])
}

// Describe says what an agent_scopes setting allows, for hints and auth status.
func Describe(setting []string) string {
	switch {
	case len(setting) == 0 || (len(setting) == 1 && setting[0] == ReadOnly):
		return "read only"
	case len(setting) == 1 && setting[0] == Full:
		return "everything you can"
	case len(setting) == 1 && setting[0] == None:
		return "nothing: agents are refused"
	}
	return strings.Join(setting, ", ")
}
