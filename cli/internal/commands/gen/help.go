package gen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

// DocsURL is a command's place in the CLI section's command reference on build.caitlyn.ai (21.1): a group's own
// page (/cli/reference/agents/draft/), a verb's section on its group's page (/cli/reference/agents/draft/#save), or a
// top-level command's own page (/cli/reference/me/). With no path, the CLI section's start page.
func DocsURL(path []string) string {
	const ref = "https://build.caitlyn.ai/cli/reference/"
	if len(path) == 0 {
		return "https://build.caitlyn.ai/cli/"
	}
	if len(path) == 1 {
		return ref + path[0] + "/"
	}
	return ref + strings.Join(path[:len(path)-1], "/") + "/#" + path[len(path)-1]
}

// GroupDocsURL is a group's own page (/cli/reference/agents/draft/), where DocsURL would name a section of its
// parent's page: `caitlyn docs agents draft` opens the group's page.
func GroupDocsURL(path []string) string {
	if len(path) == 0 {
		return DocsURL(nil)
	}
	return "https://build.caitlyn.ai/cli/reference/" + strings.Join(path, "/") + "/"
}

// help is the command's long help, from the model (2.3): description, what it needs, the impact class, when it
// fails, and when it became available.
func (c *Command) help(f *cmdutil.Factory, m *spec.Manifest, o *spec.Overlay) string {
	var b strings.Builder
	if c.Op == nil {
		fmt.Fprintf(&b, "Waits until nothing is running on it: the SDKs' wait(), a watch that starts with a snapshot.\nPrints the thing when it settles. Ctrl-C stops waiting, not the work.\n")
		b.WriteString("\nDocs: " + DocsURL(c.Spec.Path) + "\n")
		return b.String()
	}
	op := c.Op
	if op.Documentation != "" {
		b.WriteString(strings.TrimSpace(op.Documentation))
		b.WriteString("\n")
	}
	if c.Spec.Fixed != nil {
		var parts []string
		for k, v := range c.Spec.Fixed {
			parts = append(parts, fmt.Sprintf("%s %s", k, v))
		}
		sort.Strings(parts)
		fmt.Fprintf(&b, "\nActs on the %s.\n", strings.Join(parts, ", "))
	}
	var nested []string
	for _, mem := range op.Input {
		if (mem.Location == "body" || mem.Location == "payload") && !mem.Type.Scalar() && !(mem.Type.Type == "list" && mem.Type.Member != nil && mem.Type.Member.Scalar()) {
			nested = append(nested, mem.Name)
		}
	}
	if len(nested) > 0 {
		fmt.Fprintf(&b, "\nNested members (%s) are set with --set path=value, or with --from-file.\n", strings.Join(nested, ", "))
	}
	if op.Permission != nil || op.NoPermission {
		b.WriteString("\nNeeds:\n")
		if op.Permission != nil {
			line := "  " + op.Permission.Action
			if op.Scope() != "" {
				line += " (scope " + op.Scope() + ")"
			}
			if lvl := op.Permission.Level(); lvl != "" {
				line += fmt.Sprintf(" and %s on the %s", lvl, strings.TrimSuffix(strings.ReplaceAll(op.Permission.EntityType(), "-", " "), "s"))
			}
			b.WriteString(line + ".\n")
			if op.Permission.EntityType() != "" {
				b.WriteString("  Returns 404 when it isn't shared with you.")
				switch {
				case contains(op.Permission.Callers, "person") && contains(op.Permission.Callers, "api_client"):
					b.WriteString(" People and API clients.")
				case contains(op.Permission.Callers, "person"):
					b.WriteString(" People only.")
				}
				b.WriteString("\n")
			}
		} else {
			b.WriteString("  Signed in to the workspace; no permission beyond that.\n")
		}
	}
	impact := map[string]string{
		"read":        "Reads only.",
		"write":       "Writes: changes drafts or your own work.",
		"user-facing": "User-facing: changes what other people get. AI agents and CI pass --yes.",
		"destructive": "Destructive: can't be undone. Asks first; AI agents and CI pass --yes.",
	}[c.Impact]
	if c.Confirms != "" {
		impact += " AI agents and CI also pass --confirm <" + o.Name(c.Confirms).Arg + ">."
	}
	b.WriteString("\nImpact: " + impact + "\n")
	if op.Interactive {
		b.WriteString("\nOnly in the Caitlyn app while signed in: no token can call it, the CLI's included.\n")
	}
	if fails := c.failures(); fails != "" {
		b.WriteString("\nWhen it fails:\n" + fails)
	}
	if op.Since != "" {
		b.WriteString("\nAvailable from Caitlyn " + op.Since + ".  ")
	} else {
		b.WriteString("\n")
	}
	b.WriteString(DocsURL(c.Spec.Path) + "\n")
	return b.String()
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// failures lists the error examples: code, status and exit code.
func (c *Command) failures() string {
	var b strings.Builder
	seen := map[string]bool{}
	for _, ex := range c.Op.Examples {
		if ex.Error == nil {
			continue
		}
		var p struct {
			Status int    `json:"status"`
			Code   string `json:"code"`
		}
		_ = json.Unmarshal(ex.Error.Content, &p)
		if p.Code == "" || seen[p.Code] {
			continue
		}
		seen[p.Code] = true
		code := exitcode.ForStatus(p.Status)
		if e, ok := exitcode.ForCode(p.Code); ok {
			code = e
		}
		fmt.Fprintf(&b, "  %d %-24s %s  Exit code %d.\n", p.Status, p.Code, ex.Title+".", code)
	}
	return b.String()
}

// examples turns each successful @examples entry into a command line (2.3).
func (c *Command) examples(m *spec.Manifest, o *spec.Overlay) string {
	if c.Op == nil {
		return ""
	}
	var b strings.Builder
	for _, ex := range c.Op.Examples {
		if ex.Error != nil {
			continue
		}
		line, ok := c.ExampleLine(ex)
		if !ok {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "  # %s\n  %s\n", ex.Title, line)
	}
	return strings.TrimRight(b.String(), "\n")
}

// ExampleLine is the command line that sends an example's input: identifiers as the positional argument and flags,
// scalar members as flags, nested members as --set (json: for anything that isn't a scalar).
func (c *Command) ExampleLine(ex *spec.Example) (string, bool) {
	// An example about idempotency keys shows its key: without it, the line doesn't show what it's about
	withKey := ex.Error != nil && strings.Contains(string(ex.Error.Content), "IDEMPOTENCY_KEY")
	args, ok := c.ExampleArgs(ex, withKey)
	if !ok {
		return "", false
	}
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = shellQuote(a)
	}
	return wrapLine(append([]string{"caitlyn"}, parts...)), true
}

// ExampleArgs is ExampleLine's arguments, unquoted (after "caitlyn"). withKey includes the example's idempotency
// key, so the CLI conformance cases send exactly the request the example describes.
func (c *Command) ExampleArgs(ex *spec.Example, withKey bool) ([]string, bool) {
	var in map[string]json.RawMessage
	if err := json.Unmarshal(ex.Input, &in); err != nil {
		return nil, false
	}
	// An example for another fixed member (GetAgentVersion's "read live" or "a version that doesn't exist") isn't
	// this command's: agents draft get always reads the draft
	for k, want := range c.Spec.Fixed {
		var got string
		if v, ok := in[k]; ok && (json.Unmarshal(v, &got) != nil || got != want) {
			return nil, false
		}
	}
	str := func(k string) string {
		var s string
		if v, ok := in[k]; ok && json.Unmarshal(v, &s) == nil {
			return s
		}
		if v, ok := in[k]; ok {
			return string(v)
		}
		return ""
	}
	parts := append([]string{}, c.Spec.Path...)
	used := map[string]bool{}
	compact := func(id *spec.Identifier) string {
		v := str(id.Members[0])
		for _, mem := range id.Members {
			used[mem] = true
		}
		if id.Compact != nil {
			for _, mem := range id.Compact.Members {
				used[mem] = true
				if ver := str(mem); ver != "" && ver != "live" {
					v += "@" + ver
				}
			}
		}
		return v
	}
	for _, a := range c.Args {
		if len(a.ID.Members) == 0 {
			continue
		}
		v := compact(a.ID)
		if v == "" {
			return nil, false
		}
		parts = append(parts, v)
	}
	for _, id := range c.Idents {
		if len(id.ID.Members) == 0 {
			continue
		}
		v := compact(id.ID)
		if v == "" {
			continue
		}
		flag := id.Flag
		if len(id.Aliases) > 0 {
			flag = id.Aliases[0]
		}
		parts = append(parts, "--"+flag, v)
	}
	for mem := range c.Spec.Fixed {
		used[mem] = true
	}
	flagOf := map[string]memberFlag{}
	for _, mf := range c.Members {
		flagOf[mf.Member.Name] = mf
	}
	for _, mem := range c.Op.Input {
		raw, ok := in[mem.Name]
		if !ok || used[mem.Name] {
			continue
		}
		switch {
		case mem.Idempotency:
			// shown only by the help's --idempotency-key text: a fixed key in an example would be copied
			if withKey {
				parts = append(parts, "--idempotency-key", str(mem.Name))
			}
		case c.Op.IfMatch != nil && mem.Name == c.Op.IfMatch.Member:
			parts = append(parts, "--if-match", str(mem.Name))
		case mem.Name == "clear":
			var l []string
			_ = json.Unmarshal(raw, &l)
			for _, x := range l {
				parts = append(parts, "--clear", x)
			}
		case c.Op.Paginated != nil && mem.Name == c.Op.Paginated.PageSize:
			parts = append(parts, "--limit", string(raw))
		case c.Op.Paginated != nil && mem.Name == c.Op.Paginated.InputToken:
			parts = append(parts, "--cursor", str(mem.Name))
		default:
			if mf, ok := flagOf[mem.Name]; ok && !mf.Secret {
				if mem.Type.Type == "list" {
					var l []any
					_ = json.Unmarshal(raw, &l)
					for _, x := range l {
						parts = append(parts, "--"+mf.Flag, fmt.Sprint(x))
					}
				} else {
					parts = append(parts, "--"+mf.Flag, str(mem.Name))
				}
				continue
			}
			if mem.Location == "body" || mem.Location == "payload" {
				var compactJSON bytes.Buffer
				_ = json.Compact(&compactJSON, raw)
				parts = append(parts, "--set", mem.Name+"=json:"+compactJSON.String())
			}
		}
	}
	// The file to upload, when the example sends one (agents create's avatar picture is optional)
	if c.Op.UploadTarget != "" && hasPath(in, strings.Split(c.Op.UploadTarget, ".")) {
		parts = append(parts, "./file.pdf")
	}
	return parts, true
}

// shellQuote quotes a value for a POSIX shell when it needs it.
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	safe := true
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./@:=,+%", r)) {
			safe = false
			break
		}
	}
	if safe {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// wrapLine joins a command line, breaking it with " \" before flags past 100 columns.
func wrapLine(parts []string) string {
	var b strings.Builder
	col := 0
	for i, p := range parts {
		if i > 0 {
			if col+1+len(p) > 100 && strings.HasPrefix(p, "--") {
				b.WriteString(" \\\n    ")
				col = 4
			} else {
				b.WriteByte(' ')
				col++
			}
		}
		b.WriteString(p)
		col += len(p)
	}
	return b.String()
}

// hasPath reports whether a JSON object has a value at a dotted member path.
func hasPath(in map[string]json.RawMessage, path []string) bool {
	v, ok := in[path[0]]
	if !ok || string(v) == "null" {
		return false
	}
	if len(path) == 1 {
		return true
	}
	var next map[string]json.RawMessage
	if json.Unmarshal(v, &next) != nil {
		return false
	}
	return hasPath(next, path[1:])
}
