package e2e

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
)

// The CLI says it's in preview in three places, from cmdutil.Stability alone: version (text and --json) and the root
// help. Not in any other command's help or output, and not in errors.
func TestTheCLISaysItIsInPreview(t *testing.T) {
	note := cmdutil.StabilityNote()
	if cmdutil.Stability != "preview" || note == "" {
		t.Skipf("the CLI is %s", cmdutil.Stability)
	}
	r := run(t, nil, "", "version", "--json")
	var v struct{ Stability string }
	if err := json.Unmarshal([]byte(r.out), &v); r.code != 0 || err != nil || v.Stability != "preview" {
		t.Fatalf("version --json has stability preview: %d %v %s", r.code, err, r.out)
	}
	if r := run(t, nil, "", "version", "-o", "text"); r.code != 0 || strings.Count(r.out, note) != 1 {
		t.Fatalf("version says it once: %d\n%s", r.code, r.out)
	}
	if r := run(t, nil, "", "--help"); r.code != 0 || strings.Count(r.out, note) != 1 {
		t.Fatalf("the root help says it once: %d\n%s", r.code, r.out)
	}
	// Only in the rendered root help: the root's description, in describe's JSON and Markdown, doesn't carry it
	r = run(t, nil, "", "help", "--format", "json")
	var root struct {
		Command struct{ Description string } `json:"command"`
	}
	if err := json.Unmarshal([]byte(r.out), &root); r.code != 0 || err != nil || root.Command.Description == "" || strings.Contains(root.Command.Description, note) {
		t.Fatalf("help --format json leaves it out of the root's description: %d %v\n%s", r.code, err, r.out)
	}
	if r := run(t, nil, "", "help", "--format", "markdown"); r.code != 0 || strings.Contains(r.out, note) {
		t.Fatalf("help --format markdown leaves it out: %d\n%s", r.code, r.out)
	}
	// A command whose operation the model marks beta is labelled preview in its help: beta is only a release channel
	if r := run(t, nil, "", "agents", "list", "--help"); !strings.Contains(r.out, "[Preview]") || strings.Contains(r.out, "[Beta]") {
		t.Fatalf("agents list's help is marked [Preview]:\n%s", r.out)
	}
	reset(t)
	for _, args := range [][]string{
		{"agents", "--help"},
		{"agents", "list", "--help"},
		{"agents", "list", "-o", "table"},
		{"agents", "get", "NOSUCHAGENT"},
		{"no-such-command"},
	} {
		r := run(t, nil, "", args...)
		if strings.Contains(r.out+r.errOut, "preview: its commands") {
			t.Fatalf("caitlyn %s doesn't mention it:\n%s\n%s", strings.Join(args, " "), r.out, r.errOut)
		}
	}
}
