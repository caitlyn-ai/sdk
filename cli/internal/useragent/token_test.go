package useragent

import (
	"strings"
	"testing"
)

func TestToken(t *testing.T) {
	for in, want := range map[string]string{
		"claude-code":                            "claude-code",
		"Claude Code":                            "claude-code",
		"gitlab":                                 "gitlab",
		"Cursor_Agent.v2":                        "cursor-agent-v2",
		strings.Repeat("A", 40):                  strings.Repeat("a", 32),
		"Claude Code " + strings.Repeat("X", 28): "claude-code-" + strings.Repeat("x", 20),
		"":                                       "",
		"  ":                                     "",
		"???":                                    "",
	} {
		if got := Token(in); got != want {
			t.Errorf("Token(%q) = %q, want %q", in, got, want)
		}
		if len(Token(in)) > MaxLen {
			t.Errorf("Token(%q) is longer than %d", in, MaxLen)
		}
	}
}
