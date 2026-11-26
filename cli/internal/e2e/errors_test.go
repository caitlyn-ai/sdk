package e2e

import (
	"encoding/json"
	"strings"
	"testing"
)

// isJSONError reports whether stderr ends with today's machine form: one line of problem details.
func isJSONError(stderr string) bool {
	var p struct {
		Error map[string]any `json:"error"`
	}
	s := strings.TrimSpace(stderr)
	if i := strings.LastIndex(s, "\n{"); i >= 0 {
		s = s[i+1:] // after what CI prints around a run
	}
	return json.Unmarshal([]byte(s), &p) == nil && p.Error["exitCode"] != nil
}

// Errors follow the reader, not --output: a person at a terminal gets the human form, and scripts, CI and AI agents
// get the problem details they always have. --error-format, then CAITLYN_ERROR_FORMAT, win over detection both ways.
// The exit code is the same whoever reads it.
func TestErrorsFollowTheReader(t *testing.T) {
	failures := []struct {
		name  string
		args  []string
		code  int
		human string // what the human form says
	}{
		{"usage", []string{"agnets"}, 2, `caitlyn: unknown command "agnets"`},
		{"api", []string{"kb", "documents", "get", "no-such-doc", "--kb", kbID}, 6, "NOT_FOUND"},
	}
	// JSON is the configured output in every case: it shapes data, not errors
	jsonOut := map[string]string{"CAITLYN_OUTPUT": "json"}
	with := func(extra map[string]string) map[string]string {
		env := map[string]string{"CAITLYN_OUTPUT": "json"}
		for k, v := range extra {
			env[k] = v
		}
		return env
	}
	readers := []struct {
		name  string
		tty   bool
		env   map[string]string
		flags []string
		human bool
	}{
		{"a person at a terminal", true, jsonOut, nil, true},
		{"stderr not a terminal", false, jsonOut, nil, false},
		{"CI", true, with(map[string]string{"GITLAB_CI": "true"}), nil, false},
		{"an AI agent", true, with(map[string]string{"CLAUDE_CODE_CHILD_SESSION": "1"}), nil, false},
		{"--error-format json at a terminal", true, jsonOut, []string{"--error-format", "json"}, false},
		{"--error-format human when piped", false, jsonOut, []string{"--error-format=human"}, true},
		{"--error-format human in CI", false, with(map[string]string{"GITLAB_CI": "true"}), []string{"--error-format", "human"}, true},
		{"CAITLYN_ERROR_FORMAT=json at a terminal", true, with(map[string]string{"CAITLYN_ERROR_FORMAT": "json"}), nil, false},
		{"CAITLYN_ERROR_FORMAT=human when piped", false, with(map[string]string{"CAITLYN_ERROR_FORMAT": "human"}), nil, true},
		{"the flag over the variable, json", false, with(map[string]string{"CAITLYN_ERROR_FORMAT": "human"}), []string{"--error-format", "json"}, false},
		{"the flag over the variable, human", true, with(map[string]string{"CAITLYN_ERROR_FORMAT": "json", "GITLAB_CI": "true"}), []string{"--error-format", "human"}, true},
	}
	for _, fl := range failures {
		for _, rd := range readers {
			t.Run(fl.name+"/"+rd.name, func(t *testing.T) {
				reset(t)
				r := runOn(t, rd.tty, rd.env, "", append(append([]string{}, fl.args...), rd.flags...)...)
				if r.code != fl.code {
					t.Fatalf("exit %d, want %d: %s", r.code, fl.code, r.errOut)
				}
				if rd.human {
					if isJSONError(r.errOut) || !strings.Contains(r.errOut, fl.human) {
						t.Fatalf("want the human form, naming %q:\n%s", fl.human, r.errOut)
					}
					return
				}
				if !isJSONError(r.errOut) {
					t.Fatalf("want problem details as JSON:\n%s", r.errOut)
				}
			})
		}
	}
}

// The machine form is the contract AI agents rely on: an unknown command's problem details are exactly as before.
func TestUnknownCommandJSONIsUnchanged(t *testing.T) {
	r := run(t, nil, "", "nope")
	want := `{"error":{"code":"USAGE","exitCode":2,"hint":{"next":[{"run":"caitlyn commands --output json","why":"list every command"}]},"title":"unknown command \"nope\" for \"caitlyn\"","type":"https://build.caitlyn.ai/errors/USAGE"}}`
	if strings.TrimSpace(r.errOut) != want || r.code != 2 {
		t.Fatalf("exit %d:\n%s\nwant\n%s", r.code, r.errOut, want)
	}
}

// A person gets hints that suit a person: the suggestions, the group's help, its usage and its page, never
// `caitlyn commands --output json`.
func TestHumanErrorsSuitAPerson(t *testing.T) {
	r := runOn(t, true, nil, "", "agents", "draf")
	for _, want := range []string{
		`caitlyn agents: unknown command "draf"`,
		"Did you mean this?", "caitlyn agents draft",
		"Usage:", "caitlyn agents <command> [flags]",
		"caitlyn agents help",
		"https://build.caitlyn.ai/cli/reference/agents/",
	} {
		if !strings.Contains(r.errOut, want) {
			t.Errorf("no %q in:\n%s", want, r.errOut)
		}
	}
	if strings.Contains(r.errOut, "--output json") || r.code != 2 {
		t.Errorf("exit %d, and a person's hint must not ask for JSON:\n%s", r.code, r.errOut)
	}
	// a typo at the root is suggested too
	if r := runOn(t, true, nil, "", "agnets"); !strings.Contains(r.errOut, "caitlyn agents") {
		t.Errorf("no suggestion for agnets:\n%s", r.errOut)
	}
	// a usage error from a command shows that command's usage line
	r = runOn(t, true, nil, "", "kb", "list", "--nope")
	if r.code != 2 || !strings.Contains(r.errOut, "unknown flag: --nope") || !strings.Contains(r.errOut, "caitlyn knowledge-bases list [flags]") {
		t.Errorf("exit %d:\n%s", r.code, r.errOut)
	}
	// an API error keeps its hint, code, request ID and page
	reset(t)
	r = runOn(t, true, nil, "", "kb", "documents", "get", "no-such-doc", "--kb", kbID)
	for _, want := range []string{"caitlyn knowledge-bases documents list --kb " + kbID, "404 NOT_FOUND", "https://build.caitlyn.ai/errors/NOT_FOUND"} {
		if !strings.Contains(r.errOut, want) {
			t.Errorf("no %q in:\n%s", want, r.errOut)
		}
	}
	if strings.Contains(r.errOut, "Usage:") {
		t.Errorf("only a usage error shows the usage:\n%s", r.errOut)
	}
}

// --output still shapes data: JSON on stdout at a terminal, whatever happens to errors.
func TestOutputJSONStillShapesData(t *testing.T) {
	for _, env := range []map[string]string{{"CAITLYN_OUTPUT": "json"}, nil} {
		args := []string{"me"}
		if env == nil {
			args = append(args, "--output", "json")
		}
		r := runOn(t, true, env, "", args...)
		var me map[string]any
		if r.code != 0 || json.Unmarshal([]byte(r.out), &me) != nil {
			t.Fatalf("exit %d, want JSON on stdout:\n%s\n%s", r.code, r.out, r.errOut)
		}
	}
}

// A bad CAITLYN_ERROR_FORMAT is a usage error, as a bad --error-format is.
func TestErrorFormatValues(t *testing.T) {
	r := run(t, map[string]string{"CAITLYN_ERROR_FORMAT": "yaml"}, "", "me")
	if r.code != 2 || !strings.Contains(r.errOut, "CAITLYN_ERROR_FORMAT takes human or json") {
		t.Errorf("exit %d: %s", r.code, r.errOut)
	}
	r = run(t, nil, "", "me", "--error-format", "yaml")
	if r.code != 2 || !strings.Contains(r.errOut, "--error-format takes human or json") {
		t.Errorf("exit %d: %s", r.code, r.errOut)
	}
}
