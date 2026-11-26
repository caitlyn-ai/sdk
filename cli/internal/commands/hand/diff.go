package hand

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// Change is one member that differs between two JSON values (7.1): its dotted path, how it changed (+ added,
// - removed, ~ changed), and its values before and after.
type Change struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Before any    `json:"before,omitempty"`
	After  any    `json:"after,omitempty"`
}

// listKeys are the members that identify an item in a list, so lists compare item by item (as changedMembers does)
// rather than by position.
var listKeys = []string{"knowledgeBaseId", "policyId", "id", "key", "name", "server", "connectorId", "path"}

// Diff compares before and after member by member.
func Diff(before, after any) []Change {
	var out []Change
	diffAt("", before, after, &out)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func join(prefix, k string) string {
	if prefix == "" {
		return k
	}
	return prefix + "." + k
}

func diffAt(path string, a, b any, out *[]Change) {
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok {
			break
		}
		keys := map[string]bool{}
		for k := range av {
			keys[k] = true
		}
		for k := range bv {
			keys[k] = true
		}
		for k := range keys {
			x, inA := av[k]
			y, inB := bv[k]
			switch {
			case inA && !inB:
				*out = append(*out, Change{Path: join(path, k), Kind: "-", Before: x})
			case !inA && inB:
				*out = append(*out, Change{Path: join(path, k), Kind: "+", After: y})
			default:
				diffAt(join(path, k), x, y, out)
			}
		}
		return
	case []any:
		bv, ok := b.([]any)
		if !ok {
			break
		}
		if key := commonKey(av, bv); key != "" {
			index := func(l []any) (map[string]any, []string) {
				m := map[string]any{}
				var order []string
				for _, it := range l {
					id := fmt.Sprint(it.(map[string]any)[key])
					m[id] = it
					order = append(order, id)
				}
				return m, order
			}
			am, aOrder := index(av)
			bm, bOrder := index(bv)
			for _, id := range aOrder {
				p := fmt.Sprintf("%s[%s]", path, id)
				if y, ok := bm[id]; ok {
					diffAt(p, am[id], y, out)
				} else {
					*out = append(*out, Change{Path: p, Kind: "-", Before: am[id]})
				}
			}
			for _, id := range bOrder {
				if _, ok := am[id]; !ok {
					*out = append(*out, Change{Path: fmt.Sprintf("%s[%s]", path, id), Kind: "+", After: bm[id]})
				}
			}
			return
		}
	}
	if !reflect.DeepEqual(normalise(a), normalise(b)) {
		*out = append(*out, Change{Path: path, Kind: "~", Before: a, After: b})
	}
}

// commonKey finds a member every item of both lists has, from listKeys.
func commonKey(a, b []any) string {
	if len(a) == 0 && len(b) == 0 {
		return ""
	}
	for _, k := range listKeys {
		ok := true
		for _, l := range [][]any{a, b} {
			for _, it := range l {
				m, isMap := it.(map[string]any)
				if !isMap {
					return ""
				}
				if _, has := m[k]; !has {
					ok = false
				}
			}
		}
		if ok {
			return k
		}
	}
	return ""
}

func normalise(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// RenderDiff draws changes for people (12.6): one line per member path, with its glyph and role, then the values
// before and after, indented. Long text shows the changed lines only.
func RenderDiff(w io.Writer, u *ui.UI, changes []Change, indent string) {
	for _, c := range changes {
		role := map[string]ui.Role{"+": ui.Added, "-": ui.Removed, "~": ui.Changed}[c.Kind]
		fmt.Fprintf(w, "%s%s %s\n", indent, u.S(role, c.Kind), u.S(role, c.Path))
		switch c.Kind {
		case "+":
			fmt.Fprintf(w, "%s    %s\n", indent, u.S(ui.Added, short(c.After)))
		case "-":
			fmt.Fprintf(w, "%s    %s\n", indent, u.S(ui.Removed, short(c.Before)))
		case "~":
			bs, as := fmt.Sprint(c.Before), fmt.Sprint(c.After)
			if strings.Contains(bs, "\n") || strings.Contains(as, "\n") {
				lineDiff(w, u, bs, as, indent+"    ")
				continue
			}
			fmt.Fprintf(w, "%s    %s %s\n", indent, u.S(ui.Removed, "-"), short(c.Before))
			fmt.Fprintf(w, "%s    %s %s\n", indent, u.S(ui.Added, "+"), short(c.After))
		}
	}
}

func short(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return "none"
	}
	b, _ := json.Marshal(v)
	s := string(b)
	if len(s) > 200 {
		s = s[:197] + "..."
	}
	return s
}

// lineDiff shows the lines that changed in a long text, with up to three lines of context.
func lineDiff(w io.Writer, u *ui.UI, a, b, indent string) {
	al, bl := strings.Split(a, "\n"), strings.Split(b, "\n")
	// longest common subsequence, small texts only
	n, m := len(al), len(bl)
	if n*m > 250000 {
		fmt.Fprintf(w, "%s(%d lines changed)\n", indent, max(n, m))
		return
	}
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if al[i] == bl[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else {
				dp[i][j] = max(dp[i+1][j], dp[i][j+1])
			}
		}
	}
	type line struct {
		kind byte
		text string
	}
	var lines []line
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case al[i] == bl[j]:
			lines = append(lines, line{' ', al[i]})
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			lines = append(lines, line{'-', al[i]})
			i++
		default:
			lines = append(lines, line{'+', bl[j]})
			j++
		}
	}
	for ; i < n; i++ {
		lines = append(lines, line{'-', al[i]})
	}
	for ; j < m; j++ {
		lines = append(lines, line{'+', bl[j]})
	}
	show := make([]bool, len(lines))
	for k, l := range lines {
		if l.kind != ' ' {
			for d := max(0, k-3); d <= min(len(lines)-1, k+3); d++ {
				show[d] = true
			}
		}
	}
	skipped := false
	for k, l := range lines {
		if !show[k] {
			skipped = true
			continue
		}
		if skipped {
			fmt.Fprintf(w, "%s%s\n", indent, u.S(ui.Muted, u.G.Ellipsis))
			skipped = false
		}
		switch l.kind {
		case '-':
			fmt.Fprintf(w, "%s%s\n", indent, u.S(ui.Removed, "- "+l.text))
		case '+':
			fmt.Fprintf(w, "%s%s\n", indent, u.S(ui.Added, "+ "+l.text))
		default:
			fmt.Fprintf(w, "%s  %s\n", indent, l.text)
		}
	}
}

// Summary counts changes: "1 changed, 1 added."
func Summary(changes []Change) string {
	var add, rem, chg int
	for _, c := range changes {
		switch c.Kind {
		case "+":
			add++
		case "-":
			rem++
		default:
			chg++
		}
	}
	if add+rem+chg == 0 {
		return "No changes."
	}
	var parts []string
	if chg > 0 {
		parts = append(parts, fmt.Sprintf("%d changed", chg))
	}
	if add > 0 {
		parts = append(parts, fmt.Sprintf("%d added", add))
	}
	if rem > 0 {
		parts = append(parts, fmt.Sprintf("%d removed", rem))
	}
	return strings.Join(parts, ", ") + "."
}

func init() {
	// agents versions compare on a terminal: the same diff as caitlyn diff and agents draft diff
	gen.HumanViews["CompareAgentVersions"] = func(f *cmdutil.Factory, u *ui.UI, body []byte) error {
		var res struct {
			Changes []struct {
				Path   string `json:"path"`
				Before any    `json:"before"`
				After  any    `json:"after"`
			} `json:"changes"`
		}
		if err := json.Unmarshal(body, &res); err != nil {
			return err
		}
		if len(res.Changes) == 0 {
			fmt.Fprintln(f.IO.Out, u.S(ui.Muted, "No differences."))
			return nil
		}
		changes := make([]Change, 0, len(res.Changes))
		for _, c := range res.Changes {
			// Two versions of an object: the members that differ, as caitlyn diff shows them (guidance.instructions)
			bo, bok := c.Before.(map[string]any)
			ao, aok := c.After.(map[string]any)
			if bok && aok {
				for _, d := range Diff(bo, ao) {
					d.Path = c.Path + "." + d.Path
					changes = append(changes, d)
				}
				continue
			}
			kind := "~"
			switch {
			case c.Before == nil:
				kind = "+"
			case c.After == nil:
				kind = "-"
			}
			changes = append(changes, Change{Path: c.Path, Kind: kind, Before: c.Before, After: c.After})
		}
		RenderDiff(f.IO.Out, u, changes, "")
		fmt.Fprintln(f.IO.Out)
		fmt.Fprintln(f.IO.Out, u.S(ui.Muted, fmt.Sprintf("%d %s", len(changes), map[bool]string{true: "change", false: "changes"}[len(changes) == 1])))
		return nil
	}
}
