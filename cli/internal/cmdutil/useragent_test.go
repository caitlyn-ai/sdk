package cmdutil

import (
	"strings"
	"testing"

	"github.com/caitlyn-ai/sdk/cli/internal/agent"
	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/go/core"
)

func TestUserAgentToken(t *testing.T) {
	for in, want := range map[string]string{
		"claude-code":           "claude-code",
		"Claude Code":           "claude-code",
		"gitlab":                "gitlab",
		"Cursor_Agent.v2":       "cursor-agent-v2",
		strings.Repeat("A", 40): strings.Repeat("a", 32),
		"":                      "",
		"  ":                    "",
		"???":                   "",
	} {
		if got := userAgentToken(in); got != want {
			t.Errorf("userAgentToken(%q) = %q, want %q", in, got, want)
		}
	}
}

// A CI or agent name the CLI is given never stops it building a client: an odd agent name (upper case, a space, 40
// characters) is normalised into the set core.WithAgent accepts, and a name with nothing valid left is sent as
// unknown (the agent) or left out (ci). The sign-in requests' user agent carries the same tokens.
func TestOddUserAgentNamesStillBuildAClient(t *testing.T) {
	odd := "Claude Code " + strings.Repeat("X", 28) // upper case, a space, 40 characters
	cases := []struct {
		name      string
		agentName string
		ciName    string
		want      string
	}{
		{"the normal case", "claude-code", "gitlab", "caitlyn-cli#1.2.3 ci/gitlab agent/claude-code"},
		{"an odd agent name", odd, "", "caitlyn-cli#1.2.3 agent/claude-code-xxxxxxxxxxxxxxxxxxxx"},
		{"nothing valid left", "???", "!!", "caitlyn-cli#1.2.3 agent/unknown"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &Factory{
				Version: "1.2.3",
				Globals: &Globals{},
				IO:      &iostreams.IOStreams{Environ: []string{}},
				Home:    t.TempDir(),
				WorkDir: t.TempDir(),
				Agent:   agent.Mode{On: true, Name: c.agentName},
				CI:      ci.Provider{Name: c.ciName},
			}
			opts, err := f.ClientOptions()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := core.NewClient(core.SDKInfo{Version: "0.0.1"}, "your-company.caitlyn.ai", core.Token("pat_test"), opts...); err != nil {
				t.Fatalf("the client wasn't built: %v", err)
			}
			if got := f.UserAgentSuffix(); got != c.want {
				t.Fatalf("user agent suffix %q, want %q", got, c.want)
			}
		})
	}
}
