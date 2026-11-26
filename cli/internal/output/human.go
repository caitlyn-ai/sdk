package output

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// ordered is a JSON object with its members in document order.
type ordered struct {
	keys []string
	vals map[string]json.RawMessage
}

func readOrdered(raw []byte) (*ordered, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, false
	}
	o := &ordered{vals: map[string]json.RawMessage{}}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, false
		}
		k := fmt.Sprint(kt)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, false
		}
		o.keys = append(o.keys, k)
		o.vals[k] = v
	}
	return o, true
}

func (o *ordered) str(k string) string {
	var s string
	if v, ok := o.vals[k]; ok && json.Unmarshal(v, &s) == nil {
		return s
	}
	return ""
}

// detail draws one thing as a detail view: its name and identifier, scalar members, then one group per nested
// structure (12.6). An array or a scalar is printed as indented JSON.
func (p *Printer) detail(raw []byte, shape string) error {
	o, ok := readOrdered(raw)
	if !ok {
		return p.writeJSON(raw)
	}
	title := firstNonEmpty(o.str("name"), o.str("title"), o.str("displayName"), o.str("path"), o.str("id"))
	id := firstNonEmpty(o.str("id"), o.str("key"))
	if title == id {
		id = ""
	}
	var main ui.Group
	var groups []ui.Group
	for _, k := range o.keys {
		if k == "name" && title == o.str("name") || k == "id" && id != "" {
			continue
		}
		v := o.vals[k]
		if inner, ok := readOrdered(v); ok {
			g := ui.Group{Label: label(k)}
			for _, ik := range inner.keys {
				g.Rows = append(g.Rows, p.row(ik, inner.vals[ik]))
			}
			if len(g.Rows) > 12 {
				g.Rows = append(g.Rows[:12], ui.Row{Key: p.U.G.Ellipsis, Value: fmt.Sprintf("%d more: -o yaml shows them all", len(g.Rows)-12), Role: ui.Muted})
			}
			groups = append(groups, g)
			continue
		}
		main.Rows = append(main.Rows, p.row(k, v))
	}
	p.U.Detail(p.out(), title, id, append([]ui.Group{main}, groups...), "")
	return nil
}

func (p *Printer) row(k string, v json.RawMessage) ui.Row {
	text, role := p.cell(k, v)
	return ui.Row{Key: label(k), Value: text, Role: role}
}

// label turns a member name into a lower-case label: liveVersion gives "live version".
func label(k string) string {
	return strings.ReplaceAll(spec.Kebab(k), "-", " ")
}

// cell formats one value for people: text as it is, timestamps as local times (relative in tables), lists by count,
// statuses with their glyph and colour.
func (p *Printer) cell(k string, v json.RawMessage) (string, ui.Role) {
	v = bytes.TrimSpace(v)
	if len(v) == 0 || string(v) == "null" {
		return "none", ui.Muted
	}
	switch v[0] {
	case '"':
		var s string
		_ = json.Unmarshal(v, &s)
		if strings.HasSuffix(k, "At") || k == "expiresAt" {
			if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
				return p.when(t), ui.Default
			}
		}
		if k == "status" || k == "outcome" {
			return p.status(s)
		}
		return s, ui.Default
	case '[':
		var items []json.RawMessage
		_ = json.Unmarshal(v, &items)
		if len(items) == 0 {
			return "none", ui.Muted
		}
		var scalars []string
		for _, it := range items {
			var s string
			if json.Unmarshal(it, &s) == nil {
				scalars = append(scalars, s)
			} else if o, ok := readOrdered(it); ok {
				if n := firstNonEmpty(o.str("name"), o.str("displayName"), o.str("id"), o.str("path")); n != "" {
					scalars = append(scalars, n)
				}
			}
		}
		if len(scalars) == len(items) {
			return strings.Join(scalars, ", "), ui.Default
		}
		return count(len(items), "item"), ui.Default
	case '{':
		if o, ok := readOrdered(v); ok {
			if n := firstNonEmpty(o.str("displayName"), o.str("name"), o.str("id")); n != "" {
				return n, ui.Default
			}
			return count(len(o.keys), "member"), ui.Muted
		}
	}
	return string(v), ui.Default
}

// status gives a status its glyph and role: done is success, failed is an error, anything running is a warning.
func (p *Printer) status(s string) (string, ui.Role) {
	switch strings.ToLower(s) {
	case "ready", "indexed", "succeeded", "completed", "active", "available", "uploaded", "done", "compliant":
		return p.U.G.Success + " " + s, ui.Success
	case "failed", "error", "cancelled", "canceled", "expired", "non_compliant":
		return p.U.G.Failure + " " + s, ui.Error
	case "completed_with_failures", "partly_compliant", "unresolved", "needs_decision":
		return p.U.G.Warning + " " + s, ui.Warning
	case "processing", "running", "queued", "pending", "planning", "uploading", "started":
		return p.U.G.Waiting + " " + s, ui.Warning
	}
	return s, ui.Default
}

// when formats a time: relative ("2 hours ago") for people on a terminal, RFC 3339 under an AI agent (18.2).
func (p *Printer) when(t time.Time) string {
	if p.F.Agent.On || !p.F.IO.IsStdoutTTY() {
		return t.UTC().Format(time.RFC3339)
	}
	now := time.Now()
	if p.F.Now != nil {
		now = p.F.Now()
	}
	// For screenshots, recordings and the docs' captured sessions, as CAITLYN_FORCE_TTY is: the time relative times
	// are measured from. Display only; nothing else reads it.
	if v := p.F.IO.Getenv("CAITLYN_DISPLAY_NOW"); v != "" {
		if fixed, err := time.Parse(time.RFC3339, v); err == nil {
			now = fixed
		}
	}
	return Relative(t, now)
}

// Relative is "just now", "5 minutes ago", "2 hours ago", "3 days ago", or the date for anything older than a month.
func Relative(t, now time.Time) string {
	d := now.Sub(t)
	plural := func(n int, unit string) string {
		if n == 1 {
			return "1 " + unit + " ago"
		}
		return fmt.Sprintf("%d %ss ago", n, unit)
	}
	switch {
	case d < 0:
		return t.Local().Format("2 Jan 2006, 3:04 pm")
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return plural(int(d/time.Minute), "minute")
	case d < 24*time.Hour:
		return plural(int(d/time.Hour), "hour")
	case d < 30*24*time.Hour:
		return plural(int(d/(24*time.Hour)), "day")
	}
	return t.Local().Format("2 Jan 2006")
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// text prints a thing as key<TAB>value lines, or an array one item per line.
func (p *Printer) text(raw []byte) error {
	if o, ok := readOrdered(raw); ok {
		for _, k := range o.keys {
			s, _ := p.cell(k, o.vals[k])
			fmt.Fprintf(p.out(), "%s\t%s\n", k, s)
		}
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		_, err := fmt.Fprintln(p.out(), s)
		return err
	}
	_, err := fmt.Fprintf(p.out(), "%s\n", raw)
	return err
}

// Columns are a list's table columns: the overlay's for the shape, else the identifier, name, status and update time
// where the items have them (4.1).
func (p *Printer) Columns(shape string, sample []json.RawMessage) []string {
	if cols, ok := p.o.Columns[shape]; ok {
		return cols
	}
	present := map[string]bool{}
	for _, it := range sample {
		if o, ok := readOrdered(it); ok {
			for _, k := range o.keys {
				present[k] = true
			}
		}
	}
	var cols []string
	for _, c := range []string{"name", "id", "key", "path", "status", "updatedAt", "createdAt"} {
		if present[c] {
			cols = append(cols, c)
		}
	}
	if len(cols) == 0 {
		keys := make([]string, 0, len(present))
		for k := range present {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		cols = keys[:min(4, len(keys))]
	}
	return cols
}

// Rows turns list items into table rows for the columns.
func (p *Printer) Rows(cols []string, items []json.RawMessage) [][]ui.Cell {
	rows := make([][]ui.Cell, 0, len(items))
	for _, it := range items {
		row := make([]ui.Cell, len(cols))
		for i, c := range cols {
			v := at(it, c)
			text, role := p.cell(c[strings.LastIndex(c, ".")+1:], v)
			if text == "none" && role == ui.Muted && i == 0 {
				role = ui.Default
			}
			if i == 0 && role == ui.Default {
				role = ui.Strong
			}
			keep := c == "id" || strings.HasSuffix(c, "Id") || c == "key" || c == "number"
			row[i] = ui.Cell{Text: text, Role: role, Keep: keep}
		}
		rows = append(rows, row)
	}
	return rows
}

// Headers are the columns as table headers: liveVersion gives LIVE VERSION; changedBy.displayName gives CHANGED BY.
func Headers(cols []string) []string {
	out := make([]string, len(cols))
	for i, c := range cols {
		// A member of a member is headed by its own name (documentCounts.processing gives PROCESSING), unless it only
		// names its parent (changedBy.displayName gives CHANGED BY)
		if j := strings.LastIndex(c, "."); j > 0 {
			switch leaf := c[j+1:]; leaf {
			case "displayName", "name", "id":
				c = c[:j]
				if k := strings.LastIndex(c, "."); k >= 0 {
					c = c[k+1:]
				}
			default:
				c = leaf
			}
		}
		out[i] = label(c)
	}
	return out
}

// at reads a dotted member path from a JSON object.
func at(raw json.RawMessage, path string) json.RawMessage {
	cur := raw
	for _, part := range strings.Split(path, ".") {
		o, ok := readOrdered(cur)
		if !ok {
			return nil
		}
		cur, ok = o.vals[part]
		if !ok {
			return nil
		}
	}
	return cur
}

// count is "1 item", "2 items".
func count(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
