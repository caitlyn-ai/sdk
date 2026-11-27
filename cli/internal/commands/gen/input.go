package gen

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/spf13/pflag"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

type pflagFlag = pflag.Flag

// SplitCompact splits AGENT@version on its last @ (2.2). A bare AGENT has no version: the caller decides (live).
func SplitCompact(v string) (id, version string) {
	if i := strings.LastIndexByte(v, '@'); i > 0 {
		return v[:i], v[i+1:]
	}
	return v, ""
}

// input assembles the operation's input, in increasing priority: --from-file, then --set, then flags and
// identifiers. Scope identifiers come from the positional argument, the flags, or the configuration's defaults.
func (r *Run) input() error {
	c, f, cmd := r.C, r.F, r.Cobra
	// --generate-input prints a skeleton: what's given fills it, and what's required but missing is what it's for
	skeleton, _ := cmd.Flags().GetBool("generate-input")
	in := invoke.NewInput()
	r.In = in
	cfg, err := f.Config()
	if err != nil {
		return err
	}
	argc := len(c.Args)
	extra := r.Args
	if len(extra) > argc {
		extra = r.Args[argc:]
	} else {
		extra = nil
	}
	missing := []string{}
	// The command defaults (agent, knowledge_base, version) fill identifiers, but a destructive or user-facing command
	// never takes its target from the project file: a cloned repository mustn't choose what you delete or publish
	fromConfig := func(key string) string {
		v := cfg.Get(key)
		if v.Origin == config.FromProject && (c.Impact == "destructive" || c.Impact == "user-facing") {
			return ""
		}
		return v.Value
	}
	setID := func(id *spec.Identifier, v string) {
		if id.Compact != nil {
			agentID, version := SplitCompact(v)
			if version == "" {
				version = fromConfig("version")
			}
			if version == "" {
				version = "live"
			}
			r.IDs[id.Identifier] = agentID
			r.IDs[id.Compact.Identifier] = version
			for _, m := range id.Members {
				in.Set(m, agentID)
			}
			for _, m := range id.Compact.Members {
				in.Set(m, version)
			}
			return
		}
		if id.TrimSlashes {
			v = strings.Trim(v, "/")
		}
		r.IDs[id.Identifier] = v
		for _, m := range id.Members {
			in.Set(m, v)
		}
	}
	// --from-file first, so flags override it
	if c.Op != nil {
		if path, _ := cmd.Flags().GetString("from-file"); path != "" {
			if err := r.fromFile(path); err != nil {
				return err
			}
		}
		if sets, _ := cmd.Flags().GetStringArray("set"); len(sets) > 0 {
			for _, s := range sets {
				if err := applySet(f.Manifest(), c.Op, in.Values, &in.Order, s); err != nil {
					return err
				}
			}
		}
	}
	for i, a := range c.Args {
		if i < len(r.Args) {
			setID(a.ID, r.Args[i])
			continue
		}
		name := f.Overlay().Name(a.ID.Identifier)
		if d := name.Default; d != "" && fromConfig(d) != "" {
			setID(a.ID, fromConfig(d))
			continue
		}
		missing = append(missing, "<"+a.Name+">")
	}
	for _, id := range c.Idents {
		v, _ := cmd.Flags().GetString(id.Flag)
		for _, al := range id.Aliases {
			if v == "" {
				v, _ = cmd.Flags().GetString(al)
			}
		}
		if v == "" && id.Default != "" {
			v = fromConfig(id.Default)
			if id.ID.Compact != nil && v != "" && !strings.Contains(v, "@") && fromConfig("version") != "" {
				v += "@" + fromConfig("version")
			}
		}
		if v == "" {
			missing = append(missing, "--"+id.Flag)
			continue
		}
		setID(id.ID, v)
	}
	for mem, v := range c.Spec.Fixed {
		in.Set(mem, v)
		r.IDs[mem] = v
	}
	if c.Op == nil {
		if len(missing) > 0 {
			return r.missing(missing)
		}
		return nil
	}
	op := c.Op
	for _, mf := range c.Members {
		if mf.Secret {
			v, ok, err := readSecret(f, cmd, mf.Flag)
			if err != nil {
				return err
			}
			if ok {
				in.Set(mf.Member.Name, v)
			}
			continue
		}
		if !changed(cmd, mf.Flag) {
			continue
		}
		var raw string
		if mf.Member.Type.Type == "list" {
			vals, _ := cmd.Flags().GetStringArray(mf.Flag)
			raw = strings.Join(vals, ",")
		} else {
			raw, _ = cmd.Flags().GetString(mf.Flag)
		}
		if strings.HasPrefix(raw, "@") && mf.Member.Type.Type == "string" {
			v, _, err := readValue(raw)
			if err != nil {
				return err
			}
			in.Set(mf.Member.Name, v)
			continue
		}
		v, err := convert(mf.Member, mf.Member.Type, raw)
		if err != nil {
			return cmdutil.Usagef("%v", err)
		}
		in.Set(mf.Member.Name, v)
	}
	if clears, _ := cmd.Flags().GetStringArray("clear"); len(clears) > 0 {
		var list []any
		for _, cl := range clears {
			for _, part := range strings.Split(cl, ",") {
				part = strings.TrimSpace(part)
				if part == "" {
					continue
				}
				if setAt(in.Values, part) {
					return cmdutil.Usagef("%s is both set and cleared: pick one", part)
				}
				list = append(list, part)
			}
		}
		in.Set("clear", list)
	}
	if op.IfMatch != nil {
		if v, _ := cmd.Flags().GetString("if-match"); v != "" {
			in.IfMatch = &v
		}
		if in.IfMatch == nil && op.IfMatch.Required && !skeleton {
			get := r.getCommand()
			e := &cmdutil.Error{Exit: exitcode.Usage, Code: "PRECONDITION_REQUIRED", Title: fmt.Sprintf("%s needs --if-match: the ETag of what you read.", "caitlyn "+c.Spec.Name()),
				Detail: "So a change someone else made since can't be overwritten.", Hint: &cmdutil.Hint{Missing: []string{"--if-match"}}}
			if get != "" {
				e.AddNext(get+" --query etag", "read the current ETag")
			}
			e.AddNext(r.commandLine()+" --if-match <etag>", "retry with it")
			return e
		}
	}
	if op.IdempotencyHd != "" {
		in.IdempotencyKey, _ = cmd.Flags().GetString("idempotency-key")
	}
	if filters, _ := cmd.Flags().GetStringArray("filter"); len(filters) > 0 {
		for _, fl := range filters {
			eq := strings.Index(fl, "=")
			if eq <= 0 {
				return cmdutil.Usagef("--filter %q: write it as field[op]=value, for example status[eq]=failed", fl)
			}
			key, val := fl[:eq], fl[eq+1:]
			if !strings.Contains(key, "[") {
				key += "[eq]"
			}
			wire := "filter[" + strings.Replace(key, "[", "][", 1)
			var m *spec.Member
			for _, im := range op.Input {
				if im.Location == "query" && im.Wire == wire {
					m = im
				}
			}
			if m == nil {
				return cmdutil.Usagef("--filter %q: %s can't filter on that; see --help for the fields", fl, op.Name)
			}
			v, err := convert(m, m.Type, val)
			if err != nil {
				return cmdutil.Usagef("%v", err)
			}
			in.Set(m.Name, v)
		}
	}
	if op.Paginated != nil {
		if n, _ := cmd.Flags().GetInt("limit"); n > 0 {
			in.Set(op.Paginated.PageSize, json.Number(fmt.Sprint(n)))
		}
	}
	if op.UploadTarget != "" && len(extra) > 0 {
		in.Set("__file", extra[0])
	}
	for _, m := range op.Input {
		if m.Required && !in.Has(m.Name) && m.Location != "label" && !m.Idempotency && !(op.IfMatch != nil && m.Name == op.IfMatch.Member) {
			if op.UploadTarget != "" && strings.HasSuffix(op.UploadTarget, m.Name) && in.Has("__file") {
				continue
			}
			flag := "--" + spec.Kebab(m.Name)
			for _, mf := range c.Members {
				if mf.Member == m {
					flag = "--" + mf.Flag
				}
			}
			if !m.Type.Scalar() {
				flag = "--set " + m.Name + "=…"
			}
			if op.UploadTarget != "" && strings.HasSuffix(op.UploadTarget, m.Name) {
				flag = "<file>"
			}
			missing = append(missing, flag)
		}
	}
	if len(missing) > 0 && !skeleton {
		return r.missing(missing)
	}
	return nil
}

func (r *Run) missing(missing []string) error {
	e := cmdutil.Usagef("caitlyn %s needs %s.", r.C.Spec.Name(), strings.Join(missing, " and "))
	e.Code = "USAGE"
	e.Hint = &cmdutil.Hint{Missing: missing, Docs: DocsURL(r.C.Spec.Path)}
	if r.C.Op != nil {
		for _, ex := range r.C.Op.Examples {
			if ex.Error == nil {
				if line, ok := r.C.ExampleLine(ex); ok {
					e.AddNext(strings.ReplaceAll(line, " \\\n    ", " "), "for example ("+lowerFirst(ex.Title)+")")
					break
				}
			}
		}
	}
	return e
}

// getCommand is the command that reads this thing again: the `get` beside this command, with the same identifiers.
func (r *Run) getCommand() string {
	path := r.C.Spec.Path
	verbs := []string{"get"}
	for _, c := range r.F.Manifest().Commands {
		if len(c.Path) != len(path) || strings.Join(c.Path[:len(c.Path)-1], " ") != strings.Join(path[:len(path)-1], " ") {
			continue
		}
		for _, v := range verbs {
			if c.Verb() == v {
				return r.lineFor(c)
			}
		}
	}
	return ""
}

// listCommand is the list command beside this one, for "find a valid identifier", or the nearest one above it
// (agents draft get has none beside it; agents list is above it).
func (r *Run) listCommand() string {
	path := r.C.Spec.Path
	for depth := len(path) - 1; depth >= 1; depth-- {
		prefix := strings.Join(path[:depth], " ")
		for _, c := range r.F.Manifest().Commands {
			if len(c.Path) == depth+1 && c.Verb() == "list" && strings.Join(c.Path[:depth], " ") == prefix {
				return r.lineFor(c)
			}
		}
	}
	return ""
}

// lineFor spells another command with this run's identifier values.
func (r *Run) lineFor(sc *spec.Command) string {
	parts := append([]string{"caitlyn"}, sc.Path...)
	o := r.F.Overlay()
	val := func(id *spec.Identifier) string {
		v := r.IDs[id.Identifier]
		if id.Compact != nil {
			if ver := r.IDs[id.Compact.Identifier]; ver != "" && ver != "live" {
				v += "@" + ver
			}
		}
		return v
	}
	for _, a := range sc.Args {
		v := val(a)
		if v == "" {
			v = "<" + o.Name(a.Identifier).Arg + ">"
		}
		parts = append(parts, shellQuote(v))
	}
	for _, id := range sc.Identifiers {
		v := val(id)
		if v == "" {
			v = "<" + o.Name(id.Identifier).Arg + ">"
		}
		n := o.Name(id.Identifier)
		flag := n.Flag
		if len(n.Aliases) > 0 {
			flag = n.Aliases[0]
		}
		parts = append(parts, "--"+flag, shellQuote(v))
	}
	return strings.Join(parts, " ")
}

// fromFile reads the whole input from JSON or YAML (3.1). Keys are member names (or their wire names); a thing as
// `get` printed it may be given back: its etag becomes If-Match (3.4), and members the input doesn't have, such
// as createdAt, are ignored with a note.
func (r *Run) fromFile(path string) error {
	var b []byte
	var err error
	if path == "-" {
		b, err = io.ReadAll(r.F.IO.In)
	} else {
		b, err = os.ReadFile(path)
	}
	if err != nil {
		return cmdutil.Usagef("%s could not be read: %v", path, err)
	}
	j, err := output.YAMLToJSON(b)
	if err != nil {
		return cmdutil.Usagef("%s is not valid JSON or YAML: %v", path, err)
	}
	v, err := output.Decode(j)
	if err != nil {
		return cmdutil.Usagef("%s: %v", path, err)
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return cmdutil.Usagef("%s must hold an object of members", path)
	}
	op := r.C.Op
	byWire := map[string]*spec.Member{}
	for _, m := range op.Input {
		byWire[m.Wire] = m
		byWire[m.Name] = m
	}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	// keep the file's order where we can: re-read keys in document order
	if ordered := docOrder(j); len(ordered) == len(keys) {
		keys = ordered
	}
	var ignored []string
	for _, k := range keys {
		val := obj[k]
		if k == "etag" && op.IfMatch != nil {
			if s, ok := val.(string); ok && r.In.IfMatch == nil {
				r.In.IfMatch = &s
			}
			continue
		}
		m := byWire[k]
		if m == nil {
			// A thing's nested object whose members are the input's (a draft file's configuration, given back to
			// replace): its members are the input
			if inner, ok := val.(map[string]any); ok && len(inner) > 0 && allMembers(inner, byWire) {
				for ik, iv := range inner {
					r.In.Set(byWire[ik].Name, iv)
				}
				continue
			}
			ignored = append(ignored, k)
			continue
		}
		r.In.Set(m.Name, val)
	}
	if len(ignored) > 0 && !r.F.Agent.On {
		fmt.Fprintf(r.F.IO.ErrOut, "Ignored from %s (not part of %s's input): %s\n", path, op.Name, strings.Join(ignored, ", "))
	}
	return nil
}

func docOrder(j []byte) []string {
	n, err := output.JSONToYAMLNode(j)
	if err != nil || n.Kind != 4 { // yaml.MappingNode
		return nil
	}
	var out []string
	for i := 0; i+1 < len(n.Content); i += 2 {
		out = append(out, n.Content[i].Value)
	}
	return out
}

func allMembers(obj map[string]any, byWire map[string]*spec.Member) bool {
	for k := range obj {
		if m := byWire[k]; m == nil || m.Location == "label" {
			return false
		}
	}
	return true
}

// setAt reports whether the input sets the member at a dotted path, or anything inside it: clearing it as well would
// contradict the setting (3.2). Clearing guidance.identity while setting guidance.instructions is fine.
func setAt(values map[string]any, path string) bool {
	parts := strings.Split(path, ".")
	var cur any = values
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return false
		}
		cur, ok = m[p]
		if !ok {
			return false
		}
	}
	return true
}
