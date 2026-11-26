package ci

import (
	"fmt"
	"sort"
	"strings"
)

// Condition is one --fail-on condition (15.6).
type Condition struct {
	Name string
	// Exit is 1 when the condition means something failed, 3 when it means something needs action (4.6).
	Exit int
	Doc  string
}

// Conditions is every --fail-on condition any command takes, so a misspelt one is a usage error at parse time.
// Commands say which apply to them (Session.AcceptFailOn); deprecated, skew and never apply to every command.
var Conditions = []Condition{
	{"failed", 1, "an item, run or job failed"},
	{"skipped", 1, "an item was skipped"},
	{"partial", 1, "a batch completed with failures"},
	{"unresolved", 3, "a plan has unresolved items"},
	{"non_compliant", 1, "a policy review found the run non-compliant"},
	{"partly_compliant", 1, "a policy review found the run partly compliant"},
	{"changes", 3, "a plan has changes"},
	{"reset", 3, "an event stream was reset"},
	{"deprecated", 3, "a Deprecation header arrived"},
	{"skew", 3, "the server is older than the CLI's model"},
	{"never", 0, "never fail on an outcome"},
}

// GenericConditions apply to every command.
var GenericConditions = []string{"deprecated", "skew", "never"}

// Command condition sets, with their defaults (15.6).
var (
	SyncConditions       = []string{"failed", "skipped", "unresolved", "partial"}
	SyncDefaults         = []string{"failed"}
	RunConditions        = []string{"failed", "non_compliant", "partly_compliant"}
	RunDefaults          = []string{"failed"}
	DiffConditions       = []string{"changes"}
	DiffDefaults         = []string{}
	EventsTailConditions = []string{"reset"}
	EventsTailDefaults   = []string{}
)

// ConditionNamed returns a condition, or nil.
func ConditionNamed(name string) *Condition {
	for i := range Conditions {
		if Conditions[i].Name == name {
			return &Conditions[i]
		}
	}
	return nil
}

// ParseFailOn splits and checks --fail-on's values: known conditions, and never only on its own.
func ParseFailOn(values []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, v := range values {
		for _, name := range strings.Split(v, ",") {
			name = strings.ToLower(strings.TrimSpace(name))
			if name == "" {
				continue
			}
			if ConditionNamed(name) == nil {
				return nil, fmt.Errorf("%q is not a --fail-on condition (one of %s)", name, conditionList())
			}
			if !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
		}
	}
	if seen["never"] && len(out) > 1 {
		return nil, fmt.Errorf("--fail-on never can't be combined with other conditions")
	}
	return out, nil
}

func conditionList() string {
	names := make([]string, 0, len(Conditions))
	for _, c := range Conditions {
		names = append(names, c.Name)
	}
	return strings.Join(names, ", ")
}

// failOn is the effective set: what the person gave, else the command's defaults.
type failOn struct {
	given    []string
	allowed  map[string]bool
	defaults []string
	declared bool
}

func (f *failOn) active() []string {
	if len(f.given) > 0 {
		if len(f.given) == 1 && f.given[0] == "never" {
			return nil
		}
		return f.given
	}
	return f.defaults
}

// exitFor is the exit code the held conditions call for: 1 beats 3, and 0 when none applies.
func (f *failOn) exitFor(held map[string]bool) (int, []string) {
	var hit []string
	code := 0
	for _, name := range f.active() {
		if !held[name] {
			continue
		}
		hit = append(hit, name)
		c := ConditionNamed(name)
		if c.Exit == 1 || code == 0 {
			if code != 1 {
				code = c.Exit
			}
		}
	}
	sort.Strings(hit)
	return code, hit
}
