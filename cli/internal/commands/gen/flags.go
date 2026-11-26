package gen

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

// memberFlag is one input member offered as a flag.
type memberFlag struct {
	Member *spec.Member
	Flag   string
	// Stdin and File: a sensitive member is read from stdin or a file, never a flag value (3.1).
	Secret bool
}

// reservedFlags are the root's own flags and those every generated command may add: an input member never takes
// one of these names (it gets a "--to-" prefix instead).
var reservedFlags = map[string]bool{
	"profile": true, "workspace": true, "output": true, "query": true, "jq": true, "color": true, "no-color": true,
	"no-pager": true, "no-input": true, "yes": true, "confirm": true, "dry-run": true, "debug": true, "help": true,
	"project-file": true, "no-project-file": true, "ci-format": true, "report": true, "summary-file": true,
	"outputs-file": true, "fail-on": true, "read-only": true, "set": true, "from-file": true, "clear": true,
	"if-match": true, "idempotency-key": true, "wait": true, "timeout": true, "progress": true, "estimate": true,
	"all": true, "max-items": true, "generate-input": true, "version": false,
}

// memberFlags decides the flags for op's caller-given members: scalars and lists of scalars get one flag each;
// anything nested is given with --set or --from-file.
func memberFlags(op *spec.Operation, taken map[string]bool, skip map[string]bool) []memberFlag {
	var out []memberFlag
	for _, m := range op.Input {
		if skip[m.Name] || m.Location == "label" || m.Idempotency || m.Name == "clear" {
			continue
		}
		if op.IfMatch != nil && m.Name == op.IfMatch.Member {
			continue
		}
		if op.Paginated != nil && (m.Name == op.Paginated.InputToken || m.Name == op.Paginated.PageSize) {
			continue
		}
		scalar := m.Type.Scalar() || (m.Type.Type == "list" && m.Type.Member != nil && m.Type.Member.Scalar())
		if !scalar {
			continue
		}
		name := spec.Kebab(m.Name)
		if reservedFlags[name] || taken[name] {
			name = "to-" + name
		}
		taken[name] = true
		out = append(out, memberFlag{Member: m, Flag: name, Secret: m.Sensitive})
	}
	return out
}

// convert turns a flag's text into the member's JSON value: numbers and booleans parsed, lists split.
func convert(m *spec.Member, t *spec.Type, raw string) (any, error) {
	switch t.Type {
	case "integer":
		if _, err := strconv.ParseInt(raw, 10, 64); err != nil {
			return nil, fmt.Errorf("--%s: %q is not a whole number", spec.Kebab(m.Name), raw)
		}
		return json.Number(raw), nil
	case "number":
		if _, err := strconv.ParseFloat(raw, 64); err != nil {
			return nil, fmt.Errorf("--%s: %q is not a number", spec.Kebab(m.Name), raw)
		}
		return json.Number(raw), nil
	case "boolean":
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, fmt.Errorf("--%s: %q is not true or false", spec.Kebab(m.Name), raw)
		}
		return b, nil
	case "intEnum":
		if _, err := strconv.Atoi(raw); err != nil {
			return nil, fmt.Errorf("--%s: %q is not one of %s", spec.Kebab(m.Name), raw, strings.Join(t.Enum(), ", "))
		}
		return json.Number(raw), nil
	case "list":
		var items []any
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			v, err := convert(m, t.Member, part)
			if err != nil {
				return nil, err
			}
			items = append(items, v)
		}
		return items, nil
	}
	return raw, nil
}

// readValue reads @file as the file's text, and json:… as JSON.
func readValue(s string) (any, bool, error) {
	switch {
	case strings.HasPrefix(s, "@"):
		b, err := os.ReadFile(s[1:])
		if err != nil {
			return nil, false, cmdutil.Usagef("%s could not be read: %v", s[1:], err)
		}
		return string(b), true, nil
	case strings.HasPrefix(s, "json:"):
		v, err := output.Decode([]byte(s[5:]))
		if err != nil {
			return nil, false, cmdutil.Usagef("%q is not valid JSON: %v", s[5:], err)
		}
		return v, true, nil
	}
	return s, false, nil
}

// applySet applies --set path=value (3.1): dotted paths into nested members, [n] into lists. The value is typed by
// the model where the path leads to a known member; @file reads a file and json: parses JSON.
func applySet(m *spec.Manifest, op *spec.Operation, values map[string]any, order *[]string, expr string) error {
	eq := strings.IndexByte(expr, '=')
	if eq <= 0 {
		return cmdutil.Usagef("--set %q: write it as path=value, for example --set guidance.instructions=@instructions.md", expr)
	}
	path, raw := expr[:eq], expr[eq+1:]
	val, literal, err := readValue(raw)
	if err != nil {
		return err
	}
	segs := splitPath(path)
	if len(segs) == 0 {
		return cmdutil.Usagef("--set %q: the path is empty", expr)
	}
	top := op.Member(segs[0].key)
	if top == nil {
		for _, im := range op.Input {
			if im.Wire == segs[0].key {
				top = im
			}
		}
	}
	if top == nil {
		return cmdutil.Usagef("--set %q: %s has no member %q (members: %s)", expr, op.Name, segs[0].key, memberNames(op))
	}
	if !literal {
		if t := leafType(m, top.Type, segs[1:]); t != nil && t.Scalar() {
			if v, err := convert(top, t, raw); err == nil {
				val = v
			}
		}
	}
	name := top.Name
	if len(segs) == 1 {
		if _, ok := values[name]; !ok {
			*order = append(*order, name)
		}
		values[name] = val
		return nil
	}
	cur, ok := values[name]
	if !ok {
		*order = append(*order, name)
	}
	nv, err := setIn(cur, segs[1:], val)
	if err != nil {
		return cmdutil.Usagef("--set %q: %v", expr, err)
	}
	values[name] = nv
	return nil
}

type seg struct {
	key   string
	index int
	isIdx bool
}

func splitPath(p string) []seg {
	var out []seg
	for _, part := range strings.Split(p, ".") {
		for part != "" {
			i := strings.IndexByte(part, '[')
			if i < 0 {
				out = append(out, seg{key: part})
				break
			}
			if i > 0 {
				out = append(out, seg{key: part[:i]})
			}
			j := strings.IndexByte(part[i:], ']')
			if j < 0 {
				out = append(out, seg{key: part[i:]})
				break
			}
			n, err := strconv.Atoi(part[i+1 : i+j])
			if err != nil {
				out = append(out, seg{key: part[i+1 : i+j]})
			} else {
				out = append(out, seg{index: n, isIdx: true})
			}
			part = part[i+j+1:]
		}
	}
	return out
}

func setIn(cur any, segs []seg, val any) (any, error) {
	if len(segs) == 0 {
		return val, nil
	}
	s := segs[0]
	if s.isIdx {
		list, _ := cur.([]any)
		if s.index < 0 || s.index > len(list) {
			return nil, fmt.Errorf("index %d is past the end of a list of %d", s.index, len(list))
		}
		if s.index == len(list) {
			list = append(list, nil)
		}
		nv, err := setIn(list[s.index], segs[1:], val)
		if err != nil {
			return nil, err
		}
		list[s.index] = nv
		return list, nil
	}
	obj, _ := cur.(map[string]any)
	if obj == nil {
		obj = map[string]any{}
	}
	nv, err := setIn(obj[s.key], segs[1:], val)
	if err != nil {
		return nil, err
	}
	obj[s.key] = nv
	return obj, nil
}

// leafType follows a --set path through the model's shapes to the type it ends at, or nil.
func leafType(m *spec.Manifest, t *spec.Type, segs []seg) *spec.Type {
	for _, s := range segs {
		if t == nil {
			return nil
		}
		switch {
		case s.isIdx && t.Type == "list":
			t = t.Member
		case t.Type == "map":
			t = t.Value
		case t.Type == "ref":
			sh := m.Shapes[t.Ref]
			if sh == nil {
				return nil
			}
			var next *spec.Type
			for _, mem := range sh.Members {
				if mem.Wire == s.key || mem.Name == s.key {
					next = mem.Type
				}
			}
			t = next
		default:
			return nil
		}
	}
	return t
}

func memberNames(op *spec.Operation) string {
	var names []string
	for _, m := range op.Input {
		if m.Location == "body" || m.Location == "payload" {
			names = append(names, m.Name)
		}
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// stringArray is a repeatable flag that also takes comma-separated values.
func stringArray(fs *pflag.FlagSet, name, usage string) {
	fs.StringArray(name, nil, usage)
}

// changed reports whether the person gave the flag.
func changed(cmd *cobra.Command, name string) bool {
	f := cmd.Flags().Lookup(name)
	return f != nil && f.Changed
}
