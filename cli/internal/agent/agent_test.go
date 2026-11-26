package agent

import (
	"reflect"
	"testing"
)

func lookup(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestEveryMarker(t *testing.T) {
	for _, m := range Markers {
		t.Run(m.Name+" "+m.reason(), func(t *testing.T) {
			env := map[string]string{}
			files := map[string]bool{}
			if m.File != "" {
				files[m.File] = true
			} else {
				v := "1"
				if m.Value != "" {
					v = m.Value
				}
				env[m.Env] = v
			}
			e := Env{Lookup: lookup(env), FileExists: func(p string) bool { return files[p] }}
			// without a TTY every marker counts
			if got := Detect(e); !got.On || got.Name != m.Name {
				t.Fatalf("no TTY: %+v", got)
			}
			// with a TTY only the subprocess-only markers count
			e.StdinTTY = true
			if got := Detect(e); got.On == m.IDEWide {
				t.Fatalf("TTY: %+v (IDE-wide %v)", got, m.IDEWide)
			}
		})
	}
}

func TestExplicitSwitch(t *testing.T) {
	none := func(string) bool { return false }
	if got := Detect(Env{Lookup: lookup(map[string]string{"CAITLYN_AGENT": "1"}), StdinTTY: true, FileExists: none}); !got.On {
		t.Fatal("CAITLYN_AGENT=1 always wins")
	}
	// CAITLYN_AGENT=0 turns it off only for a person at a terminal (18.5): an agent's shell has none
	marker := map[string]string{"CAITLYN_AGENT": "0", "CLAUDE_CODE_CHILD_SESSION": "1"}
	if got := Detect(Env{Lookup: lookup(marker), StdinTTY: true, FileExists: none}); got.On {
		t.Fatal("CAITLYN_AGENT=0 with a TTY turns agent mode off")
	}
	if got := Detect(Env{Lookup: lookup(marker), StdinTTY: false, FileExists: none}); !got.On {
		t.Fatal("CAITLYN_AGENT=0 without a TTY must be ignored when a marker is present")
	}
	if got := Detect(Env{Lookup: lookup(map[string]string{"AI_AGENT": "My Tool"}), FileExists: none}); !got.On || got.Name != "my-tool" {
		t.Fatalf("AI_AGENT: %+v", got)
	}
	if got := Detect(Env{Lookup: lookup(map[string]string{"CURSOR_EXTENSION_HOST_ROLE": "user"}), FileExists: none}); got.On {
		t.Fatal("a marker with the wrong value must not count")
	}
}

func TestEffectiveScopes(t *testing.T) {
	granted := []string{"api:admin"}
	cases := []struct {
		setting  []string
		readOnly bool
		want     []string
	}{
		{nil, false, []string{"api:read"}},
		{[]string{"read-only"}, false, []string{"api:read"}},
		{[]string{"full"}, false, []string{"api:admin"}},
		{[]string{"full"}, true, []string{"api:read"}},
		{[]string{"none"}, false, []string{}},
		{[]string{"agents:write", "knowledge-bases:read"}, false, []string{"agents:write", "knowledge-bases:read"}},
		{[]string{"agents:write"}, true, []string{"agents:read"}},
	}
	for _, c := range cases {
		if got := Effective(c.setting, granted, c.readOnly); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v readOnly=%v: got %v, want %v", c.setting, c.readOnly, got, c.want)
		}
	}
	// never more than the grant
	if got := Effective([]string{"agents:admin"}, []string{"agents:write"}, false); len(got) != 0 {
		t.Errorf("a scope beyond the grant must be dropped, got %v", got)
	}
}

// A grant that names areas: the surface scope in it is a ceiling, not breadth (app !2138, round 5, I1). The
// read-only agent asks for each granted area at read, never api:read, which the server refuses for such a grant;
// a bare surface grant still asks for api:read.
func TestEffectiveScopesAgainstAGrantThatNamesAreas(t *testing.T) {
	areas := []string{"agents:write", "knowledge-bases:read", "api:write"}
	cases := []struct {
		name     string
		granted  []string
		setting  []string
		readOnly bool
		want     []string
	}{
		{"read-only, areas", areas, nil, false, []string{"agents:read", "knowledge-bases:read"}},
		{"read-only, a bare surface grant", []string{"api:write"}, nil, false, []string{"api:read"}},
		{"read-only, a bare read grant", []string{"api:read"}, []string{"read-only"}, false, []string{"api:read"}},
		{"full, areas: the grant exactly", areas, []string{"full"}, false, []string{"agents:write", "api:write", "knowledge-bases:read"}},
		{"full keeps a non-tier scope", []string{"agents:write", "offline_access", "api:write"}, []string{"full"}, false, []string{"agents:write", "api:write", "offline_access"}},
		{"full and the read-only cap, areas", areas, []string{"full"}, true, []string{"agents:read", "knowledge-bases:read"}},
		{"the grant's ceiling caps an area", []string{"agents:write", "api:read"}, []string{"agents:write"}, false, []string{}},
		{"the grant's ceiling, full and read-only", []string{"agents:write", "api:read"}, []string{"full"}, true, []string{"agents:read"}},
		// round 9, M1: a surface scope in a list that names areas is the list's ceiling, never every granted area
		{"a list of an area and api:read", []string{"agents:write", "knowledge-bases:read", "users:write", "api:write"}, []string{"agents:read", "api:read"}, false, []string{"agents:read"}},
		{"the list's ceiling caps its areas", []string{"agents:write", "knowledge-bases:read", "users:write", "api:write"}, []string{"agents:write", "users:write", "api:read"}, false, []string{"agents:read", "users:read"}},
		{"a list of an area and api:write", areas, []string{"agents:write", "api:write"}, false, []string{"agents:write"}},
		{"a list of an area and api:read, bare grant", []string{"api:write"}, []string{"agents:read", "api:read"}, false, []string{"agents:read"}},
		{"api:write in a list, areas", areas, []string{"api:write"}, false, []string{"agents:write", "knowledge-bases:read"}},
		{"an area not chosen is dropped", areas, []string{"users:read", "agents:read"}, false, []string{"agents:read"}},
		{"an area above its grant is dropped", areas, []string{"knowledge-bases:write"}, false, []string{}},
		{"areas without a surface scope", []string{"agents:write"}, nil, false, []string{"agents:read"}},
	}
	for _, c := range cases {
		if got := Effective(c.setting, c.granted, c.readOnly); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// What StricterAgentScopes makes from a locked read-only and a chosen list naming an area and a surface scope asks
// for that area at read only, whatever the grant holds (round 9, M1).
func TestEffectiveOfAStricterSetting(t *testing.T) {
	grant := []string{"agents:write", "knowledge-bases:read", "users:write", "api:write"}
	for _, setting := range [][]string{{"agents:read", "api:read"}, {"agents:read"}} {
		if got := Effective(setting, grant, false); !reflect.DeepEqual(got, []string{"agents:read"}) {
			t.Errorf("%v: got %v, want [agents:read]", setting, got)
		}
		// the CLI's own pre-check agrees with the token
		allowed := Effective(setting, nil, false)
		if AnyCovers(allowed, "knowledge-bases:read") || !AnyCovers(allowed, "agents:read") {
			t.Errorf("%v: the pre-check allows %v", setting, allowed)
		}
	}
}

func TestAnyCoversJudgesTheWholeGrant(t *testing.T) {
	areas := []string{"agents:write", "knowledge-bases:read", "api:write"}
	for _, c := range []struct {
		granted []string
		needed  string
		ok      bool
	}{
		{areas, "agents:read", true}, {areas, "agents:write", true}, {areas, "knowledge-bases:read", true},
		{areas, "api:read", false}, {areas, "knowledge-bases:write", false}, {areas, "users:read", false},
		{areas, "roles:write", false}, {areas, "mcp:read", false},
		{[]string{"agents:write", "api:read"}, "agents:write", false},
		{[]string{"agents:read", "mcp:read"}, "mcp:read", false},
		{[]string{"api:write"}, "users:read", true}, {[]string{"api:write"}, "api:read", true},
		{[]string{"api:read"}, "agents:write", false},
	} {
		if AnyCovers(c.granted, c.needed) != c.ok {
			t.Errorf("AnyCovers(%v, %s) != %v", c.granted, c.needed, c.ok)
		}
	}
}

// api: covers api: and the known areas only: never mcp:, which is for the MCP server, nor a family that doesn't
// exist, such as the typo agent:read. The CLI drops them itself rather than send what the server refuses (app
// !2138, round 6, L4).
func TestAPIDoesNotCoverMCPOrUnknownFamilies(t *testing.T) {
	for _, n := range []string{"mcp:read", "agent:read", "nonsense:write"} {
		if Covers("api:admin", n) {
			t.Errorf("api:admin covers %s", n)
		}
		if AnyCovers([]string{"api:write"}, n) {
			t.Errorf("a bare api:write grant covers %s", n)
		}
		if got := Effective([]string{n}, []string{"api:admin"}, false); len(got) != 0 {
			t.Errorf("Effective([%s]) against api:admin = %v, want nothing", n, got)
		}
	}
	if !Covers("api:read", "agents:read") || !Covers("api:write", "api:read") {
		t.Error("api: must still cover the known areas and itself")
	}
}

func TestCovers(t *testing.T) {
	for _, c := range []struct {
		g, n string
		ok   bool
	}{
		{"api:read", "agents:read", true}, {"api:read", "agents:write", false}, {"api:admin", "users:write", true},
		{"agents:admin", "agents:read", true}, {"agents:write", "agents:admin", false}, {"chat:write", "agents:read", false},
	} {
		if Covers(c.g, c.n) != c.ok {
			t.Errorf("Covers(%s, %s) != %v", c.g, c.n, c.ok)
		}
	}
}

func TestCacheKeyDependsOnScopes(t *testing.T) {
	a := CacheKey("w", "default", []string{"api:read"})
	b := CacheKey("w", "default", []string{"agents:read"})
	if a == b || a != CacheKey("w", "default", []string{"api:read"}) {
		t.Fatalf("%s %s", a, b)
	}
}
