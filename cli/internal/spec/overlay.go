package spec

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"

	cli "github.com/caitlyn-ai/sdk/cli"
)

// Overlay is naming.yaml: the CLI's own naming choices.
type Overlay struct {
	Aliases     map[string][]string        `yaml:"aliases"`
	Identifiers map[string]*IdentifierName `yaml:"identifiers"`
	Columns     map[string][]string        `yaml:"columns"`
	Next        map[string][]NextStep      `yaml:"next"`
	Impact      map[string]string          `yaml:"impact"`
	Confirm     map[string]string          `yaml:"confirm"`
	Scopes      map[string]string          `yaml:"scopes"`
	Groups      map[string]*GroupHelp      `yaml:"groups"`
	Commands    map[string]*GroupHelp      `yaml:"commands"`
}

// GroupHelp is a command group's or a hand-written command's help: its one line, its paragraph (or a paragraph put
// before its own), and example command lines, each after an optional `# title` line.
type GroupHelp struct {
	Short    string   `yaml:"short"`
	About    string   `yaml:"about"`
	Long     string   `yaml:"long"`
	Examples []string `yaml:"examples"`
	// Recipe is the line naming the recipe that uses it: "Recipe: <url>", last in the help.
	Recipe string `yaml:"recipe"`
}

// IdentifierName is how a scope identifier is spelt on the command line.
type IdentifierName struct {
	Flag    string   `yaml:"flag"`
	Aliases []string `yaml:"aliases"`
	Arg     string   `yaml:"arg"`
	Default string   `yaml:"default"`
}

// NextStep is one "try:" line for an error code.
type NextStep struct {
	Run string `yaml:"run" json:"run"`
	Why string `yaml:"why" json:"why"`
}

var (
	overlayOnce sync.Once
	overlay     *Overlay
	overlayErr  error
)

// LoadOverlay returns the embedded naming.yaml, parsed once.
func LoadOverlay() (*Overlay, error) {
	overlayOnce.Do(func() {
		overlay, overlayErr = ParseOverlay(cli.NamingOverlay)
	})
	return overlay, overlayErr
}

// MustOverlay is LoadOverlay for code that runs after the root command has loaded it.
func MustOverlay() *Overlay {
	o, err := LoadOverlay()
	if err != nil {
		panic(err)
	}
	return o
}

// ParseOverlay reads an overlay.
func ParseOverlay(b []byte) (*Overlay, error) {
	var o Overlay
	dec := yaml.NewDecoder(strings.NewReader(string(b)))
	dec.KnownFields(true)
	if err := dec.Decode(&o); err != nil {
		return nil, fmt.Errorf("naming.yaml: %w", err)
	}
	return &o, nil
}

// Name returns how an identifier is spelt: its overlay entry, or one made from its name (knowledgeBaseId gives
// knowledge-base).
func (o *Overlay) Name(identifier string) IdentifierName {
	if n, ok := o.Identifiers[identifier]; ok && n != nil {
		out := *n
		if out.Arg == "" {
			out.Arg = out.Flag
		}
		return out
	}
	base := strings.TrimSuffix(identifier, "Id")
	k := Kebab(base)
	return IdentifierName{Flag: k, Arg: k}
}

// Kebab spells a lower camel case name in kebab-case: knowledgeBases gives knowledge-bases.
func Kebab(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r + ('a' - 'A'))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Check reports every overlay entry that names something the manifest does not have, so a model change that
// removes or renames something fails the build instead of leaving a stale name (the CLI design, 11.2).
func (o *Overlay) Check(m *Manifest) []string {
	var problems []string
	nouns := map[string]bool{}
	identifiers := map[string]bool{}
	codes := map[string]bool{}
	for _, c := range m.Commands {
		for i := 1; i < len(c.Path); i++ {
			nouns[strings.Join(c.Path[:i], " ")] = true
		}
		for _, id := range append(append([]*Identifier{}, c.Args...), c.Identifiers...) {
			identifiers[id.Identifier] = true
			if id.Compact != nil {
				identifiers[id.Compact.Identifier] = true
			}
		}
	}
	for _, op := range m.Operations {
		for code := range op.Codes() {
			codes[code] = true
		}
	}
	for noun := range o.Aliases {
		// A noun the model doesn't have yet (unattended-runs before it is modelled) is allowed only if listed as future
		if !nouns[noun] && !futureNouns[noun] {
			problems = append(problems, fmt.Sprintf("aliases: %q is not a command noun", noun))
		}
	}
	for id := range o.Identifiers {
		if !identifiers[id] {
			problems = append(problems, fmt.Sprintf("identifiers: %q is not a scope identifier", id))
		}
	}
	for shape, cols := range o.Columns {
		s, ok := m.Shapes[shape]
		if !ok {
			problems = append(problems, fmt.Sprintf("columns: %q is not a shape", shape))
			continue
		}
		for _, col := range cols {
			if !m.hasPath(s, col) {
				problems = append(problems, fmt.Sprintf("columns: %s has no member %q", shape, col))
			}
		}
	}
	for code := range o.Next {
		if !codes[code] && !clientCodes[code] {
			problems = append(problems, fmt.Sprintf("next: %q is not an error code any operation returns", code))
		}
	}
	for op, class := range o.Impact {
		if m.Operations[op] == nil {
			problems = append(problems, fmt.Sprintf("impact: %q is not an operation", op))
		}
		switch class {
		case "read", "write", "user-facing", "destructive":
		default:
			problems = append(problems, fmt.Sprintf("impact: %s has the unknown class %q", op, class))
		}
	}
	for op, id := range o.Confirm {
		if m.Operations[op] == nil {
			problems = append(problems, fmt.Sprintf("confirm: %q is not an operation", op))
		} else if !identifiers[id] {
			problems = append(problems, fmt.Sprintf("confirm: %s names %q, which is not a scope identifier", op, id))
		}
	}
	families := map[string]bool{}
	for _, s := range m.Permissions {
		families[strings.SplitN(s, ":", 2)[0]] = true
	}
	for f := range o.Scopes {
		if !families[f] {
			problems = append(problems, fmt.Sprintf("scopes: %q is not a scope family in the permission catalogue", f))
		}
	}
	sort.Strings(problems)
	return problems
}

// futureNouns are aliases kept for nouns the model is about to gain (unattended runs), so the overlay need not
// change on the day they arrive. Each must be removed from here once the model has it.
var futureNouns = map[string]bool{"unattended-runs": true}

// clientCodes are error codes the CLI or SDK raises itself rather than the server.
var clientCodes = map[string]bool{"PRECONDITION_REQUIRED": true, "AUTH_API_SCOPE_DENIED": true, "NOT_AVAILABLE_TO_CREDENTIALS": true}

func (m *Manifest) hasPath(s *Shape, path string) bool {
	parts := strings.Split(path, ".")
	cur := s
	for i, p := range parts {
		var found *Member
		for _, mem := range cur.Members {
			if mem.Wire == p || mem.Name == p {
				found = mem
				break
			}
		}
		if found == nil {
			return false
		}
		if i == len(parts)-1 {
			return true
		}
		if found.Type.Type != "ref" {
			return false
		}
		cur = m.Shapes[found.Type.Ref]
		if cur == nil {
			return false
		}
	}
	return true
}
