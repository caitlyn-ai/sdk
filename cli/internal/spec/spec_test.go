package spec

import (
	"strings"
	"testing"
)

// TestOverlayNamesOnlyWhatTheModelHas fails the build when naming.yaml names a command noun, identifier, shape,
// member, operation or error code the manifest doesn't have (11.2).
func TestOverlayNamesOnlyWhatTheModelHas(t *testing.T) {
	m, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	o, err := LoadOverlay()
	if err != nil {
		t.Fatal(err)
	}
	if problems := o.Check(m); len(problems) > 0 {
		t.Fatalf("naming.yaml:\n  %s", strings.Join(problems, "\n  "))
	}
}

func TestOverlayCheckCatchesStaleNames(t *testing.T) {
	m, _ := Load()
	o, err := ParseOverlay([]byte("aliases: {widgets: [w]}\nidentifiers: {widgetId: {flag: widget}}\ncolumns: {Agent: [nope]}\nnext: {NO_SUCH_CODE: []}\nimpact: {NoSuchOp: write}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := o.Check(m); len(got) != 5 {
		t.Fatalf("want 5 problems, got %v", got)
	}
}

func TestManifestShape(t *testing.T) {
	m, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if m.Version == "" || m.ModelVersion == "" || len(m.Commands) == 0 {
		t.Fatalf("manifest: version %q model %q, %d commands", m.Version, m.ModelVersion, len(m.Commands))
	}
	seen := map[string]bool{}
	for _, c := range m.Commands {
		if seen[c.Name()] {
			t.Errorf("two commands at %s", c.Name())
		}
		seen[c.Name()] = true
		if c.Operation != "" && m.Op(c.Operation) == nil {
			t.Errorf("%s calls %s, which isn't in the manifest", c.Name(), c.Operation)
		}
	}
	// the compact form: an agent and its version are one value
	for _, name := range []string{"agents versions get", "agents versions publish"} {
		var c *Command
		for _, x := range m.Commands {
			if x.Name() == name {
				c = x
			}
		}
		if c == nil || len(c.Args) != 1 || c.Args[0].Compact == nil {
			t.Errorf("%s should take AGENT@version", name)
		}
	}
}

func TestKebab(t *testing.T) {
	for in, want := range map[string]string{"knowledgeBases": "knowledge-bases", "deleteMany": "delete-many", "get": "get"} {
		if got := Kebab(in); got != want {
			t.Errorf("Kebab(%s) = %s", in, got)
		}
	}
}
