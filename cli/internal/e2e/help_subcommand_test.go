package e2e

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// help is a subcommand at every level: `caitlyn <group> help`, `caitlyn <group> <cmd> help` and
// `caitlyn help <group> [cmd]` show the same as --help there, on stdout with exit 0, for hand-written and generated
// commands alike.
func TestHelpAsASubcommand(t *testing.T) {
	cases := []struct {
		name string
		path []string
	}{
		{"the root", nil},
		{"a hand-written group", []string{"ai"}},
		{"a generated group", []string{"conversations"}},
		{"a generated group two deep", []string{"agents", "draft"}},
		{"a generated command with no argument", []string{"me"}},
		{"a generated command three deep", []string{"agents", "options", "models"}},
		{"a hand-written command with no argument", []string{"ai", "status"}},
		{"an alias", []string{"kb", "documents"}},
	}
	// JSON is the configured output: help is text all the same
	env := map[string]string{"CAITLYN_OUTPUT": "json"}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			want := run(t, env, "", append(append([]string{}, c.path...), "--help")...)
			if want.code != 0 || want.out == "" || strings.HasPrefix(want.out, "{") {
				t.Fatalf("--help: exit %d:\n%s\n%s", want.code, want.out, want.errOut)
			}
			forms := [][]string{append(append([]string{}, c.path...), "help"), append([]string{"help"}, c.path...)}
			for _, args := range forms {
				got := run(t, env, "", args...)
				if got.code != 0 || got.out != want.out || got.errOut != "" {
					t.Errorf("caitlyn %s: exit %d, stderr %q, and stdout differs from --help:\n%s", strings.Join(args, " "), got.code, got.errOut, got.out)
				}
			}
		})
	}
}

// --output json on the command line makes help data: the command's description, the same one caitlyn commands
// --json gives for it, with its input's JSON Schema.
func TestHelpAsASubcommandWithOutputJSON(t *testing.T) {
	all := run(t, nil, "", "commands", "--json")
	var tree struct {
		Commands []map[string]any `json:"commands"`
	}
	if err := json.Unmarshal([]byte(all.out), &tree); err != nil {
		t.Fatal(err)
	}
	for _, path := range [][]string{{"agents", "draft"}, {"me"}, {"ai"}} {
		r := run(t, nil, "", append(append([]string{}, path...), "help", "--output", "json")...)
		var doc struct {
			Command map[string]any `json:"command"`
		}
		if r.code != 0 || json.Unmarshal([]byte(r.out), &doc) != nil {
			t.Fatalf("%v: exit %d:\n%s\n%s", path, r.code, r.out, r.errOut)
		}
		name := strings.Join(path, " ")
		var listed map[string]any
		for _, c := range tree.Commands {
			if c["name"] == name {
				listed = c
			}
		}
		if listed == nil || !reflect.DeepEqual(doc.Command, listed) {
			t.Errorf("%s help --output json: not caitlyn commands --json's entry:\n%v\n%v", name, doc.Command, listed)
		}
	}
}

// help is help only where a subcommand would go: a command that takes an argument gets "help" as that argument,
// and caitlyn help's own topics keep working.
func TestHelpNeverShadowsAnArgument(t *testing.T) {
	reset(t)
	r := run(t, nil, "", "agents", "get", "help")
	if r.code != 6 {
		t.Fatalf("agents get help reads the agent called help: exit %d:\n%s\n%s", r.code, r.out, r.errOut)
	}
	var reqs []map[string]any
	getJSON(t, "/__mock/requests", &reqs)
	found := false
	for _, q := range reqs {
		if p, _ := q["path"].(string); strings.HasSuffix(p, "/agents/help") {
			found = true
		}
	}
	if !found {
		t.Errorf("no request for the agent called help: %v", reqs)
	}
	// a flag's value is not help (me runs, the endpoint coming from CAITLYN_ENDPOINT), and flags before help are read as flags
	if r := run(t, nil, "", "--workspace", "help", "me"); r.code != 0 || strings.Contains(r.out, "Usage:") {
		t.Errorf("--workspace help me: exit %d\n%s", r.code, r.out)
	}
	if r := run(t, nil, "", "-o", "json", "me", "help"); r.code != 0 || !strings.HasPrefix(r.out, "{") {
		t.Errorf("-o json me help: exit %d\n%s", r.code, r.out)
	}
	// a word after help is not help
	if r := run(t, nil, "", "ai", "help", "setup"); r.code != 2 {
		t.Errorf("ai help setup: exit %d", r.code)
	}
	// the topics: caitlyn help agents is the AGENTS.md section, not the agents group's help
	topic := run(t, nil, "", "help", "agents")
	group := run(t, nil, "", "agents", "help")
	if topic.code != 0 || !strings.Contains(topic.out, "## Caitlyn CLI") || group.code != 0 || topic.out == group.out {
		t.Errorf("help agents: exit %d, agents help: exit %d\n%s", topic.code, group.code, topic.out)
	}
	if r := run(t, nil, "", "help", "exit-codes"); r.code != 0 || !strings.Contains(r.out, "Exit codes") {
		t.Errorf("help exit-codes: exit %d", r.code)
	}
	// and a group's commands under it still answer caitlyn help agents <command>
	if r := run(t, nil, "", "help", "agents", "draft"); r.code != 0 || r.out != run(t, nil, "", "agents", "draft", "--help").out {
		t.Errorf("help agents draft: exit %d", r.code)
	}
}
