package gen

import "testing"

func TestWithoutFlag(t *testing.T) {
	cases := []struct{ line, flag, want string }{
		{`caitlyn agents draft update GHT7YRWXPL --if-match '"draft-1"' --set guidance.instructions=x`, "--if-match", `caitlyn agents draft update GHT7YRWXPL --set guidance.instructions=x`},
		{`caitlyn kb update KB --description 'Harbour Freight'\''s policies' --if-match=x`, "--if-match", `caitlyn kb update KB --description 'Harbour Freight'\''s policies'`},
		{`caitlyn agents create --name x`, "--idempotency-key", `caitlyn agents create --name x`},
	}
	for _, c := range cases {
		if got := withoutFlag(c.line, c.flag); got != c.want {
			t.Errorf("withoutFlag(%q, %s) = %q, want %q", c.line, c.flag, got, c.want)
		}
	}
}

func TestAddedFlag(t *testing.T) {
	for step, want := range map[string]string{
		"{command} --if-match <etag>":           "if-match",
		"{command} --idempotency-key=<new key>": "idempotency-key",
		"{get} --query etag":                    "",
		"caitlyn auth login --scopes {scope}":   "",
	} {
		if got := addedFlag(step); got != want {
			t.Errorf("addedFlag(%q) = %q, want %q", step, got, want)
		}
	}
}
