package gen

import "testing"

// A create's --wait follows what it made: the id in the 202's body, or failing that its Location.
func TestCreatedID(t *testing.T) {
	cases := []struct {
		body     map[string]any
		location string
		want     string
	}{
		{map[string]any{"id": "KB4T7YQ2WL"}, "/api/v3/knowledge-bases/KBOTHER", "KB4T7YQ2WL"},
		{map[string]any{}, "/api/v3/knowledge-bases/KB4T7YQ2WL", "KB4T7YQ2WL"},
		{nil, "https://your-company.caitlyn.ai/api/v3/knowledge-bases/KB4T7YQ2WL/", "KB4T7YQ2WL"},
		{map[string]any{"name": "Handbook"}, "", ""},
	}
	for _, c := range cases {
		if got := createdID(c.body, c.location); got != c.want {
			t.Errorf("createdID(%v, %q) = %q, want %q", c.body, c.location, got, c.want)
		}
	}
}
