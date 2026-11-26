package ui

import (
	"fmt"
	"io"
	"strings"
)

// DiffOp is what happened to a resource or member.
type DiffOp int

// The operations, each with its glyph and role (12.3): + added, - removed, ~ changed.
const (
	DiffChanged DiffOp = iota
	DiffAdded
	DiffRemoved
)

func (o DiffOp) glyph() string { return [...]string{"~", "+", "-"}[o] }
func (o DiffOp) role() Role    { return [...]Role{Changed, Added, Removed}[o] }

// DiffMember is one changed member path.
type DiffMember struct {
	Op   DiffOp
	Path string
	// Before and After are the values; for an addition only After, for a removal only Before.
	Before, After string
	// Text: a long text member (instructions run to pages), shown as a word-level diff with three lines of context
	// rather than both values.
	Text bool
}

// DiffResource is one resource in a plan: its kind, name, identifier and a note ("draft").
type DiffResource struct {
	Op             DiffOp
	Kind, Name, ID string
	Note           string
	Members        []DiffMember
}

// Diff is a plan (12.6, 12.10): a strong title, one line per resource and per changed member path, the unchanged
// counted rather than shown, and a strong summary.
type Diff struct {
	Title     string
	Resources []DiffResource
	// Unchanged lines are counts ("1 knowledge base set-up unchanged"), shown muted.
	Unchanged []string
	Summary   string
}

// ContextLines is how many unchanged lines a word-level diff keeps around each change.
const ContextLines = 3

// RenderDiff writes a diff for people. Without colour, changed words are marked [-like this-] and {+like this+}, so
// colour never carries the meaning alone.
func (u *UI) RenderDiff(w io.Writer, d Diff) {
	s := u.Out
	if d.Title != "" {
		fmt.Fprintln(w, s.Paint(Strong, d.Title))
		fmt.Fprintln(w)
	}
	for _, r := range d.Resources {
		head := s.Paint(r.Op.role(), r.Op.glyph()+" "+r.Kind) + " " + r.Name
		if r.ID != "" && r.ID != r.Name {
			head += "  " + s.Paint(Muted, r.ID)
		}
		if r.Note != "" {
			head += "  " + s.Paint(Muted, r.Note)
		}
		fmt.Fprintln(w, head)
		for _, m := range r.Members {
			u.diffMember(w, m)
		}
	}
	for _, line := range d.Unchanged {
		fmt.Fprintln(w, "  "+s.Paint(Muted, line))
	}
	if d.Summary != "" {
		fmt.Fprintln(w)
		fmt.Fprintln(w, s.Paint(Strong, d.Summary))
	}
}

func (u *UI) diffMember(w io.Writer, m DiffMember) {
	s := u.Out
	line := "    " + s.Paint(m.Op.role(), m.Op.glyph()+" "+m.Path)
	if m.Text && m.Op == DiffChanged {
		fmt.Fprintln(w, line)
		for _, l := range u.wordDiff(m.Before, m.After, u.IO.ProseWidth()-8) {
			fmt.Fprintln(w, "        "+l)
		}
		return
	}
	switch m.Op {
	case DiffAdded:
		if m.After != "" {
			line += "  " + m.After
		}
	case DiffRemoved:
		if m.Before != "" {
			line += "  " + s.Paint(Muted, m.Before)
		}
	default:
		line += "  " + s.Paint(Muted, orNone(m.Before)) + " " + s.Paint(Muted, u.G.Next) + " " + orNone(m.After)
	}
	fmt.Fprintln(w, line)
}

func orNone(v string) string {
	if v == "" {
		return "(none)"
	}
	return v
}

type wordOp struct {
	op   int // 0 same, 1 added, -1 removed
	word string
}

// wordDiff diffs two texts word by word, wraps the result to width, and keeps ContextLines unchanged lines around
// each change; elided runs show as one ellipsis line.
func (u *UI) wordDiff(before, after string, width int) []string {
	ops := diffWords(strings.Fields(before), strings.Fields(after))
	colour := Colourful(u.Out)
	type cell struct {
		text    string
		w       int
		changed bool
	}
	var cells []cell
	for i := 0; i < len(ops); {
		op := ops[i]
		j := i
		var words []string
		for j < len(ops) && ops[j].op == op.op {
			words = append(words, ops[j].word)
			j++
		}
		for k, word := range words {
			t := word
			switch {
			case op.op == 1 && colour:
				t = u.S(Added, word)
			case op.op == -1 && colour:
				t = u.S(Removed, word)
			case op.op == 1:
				if k == 0 {
					word = "{+" + word
				}
				if k == len(words)-1 {
					word += "+}"
				}
				t = word
			case op.op == -1:
				if k == 0 {
					word = "[-" + word
				}
				if k == len(words)-1 {
					word += "-]"
				}
				t = word
			}
			cells = append(cells, cell{text: t, w: DisplayWidth(word), changed: op.op != 0})
		}
		i = j
	}
	// wrap into lines, remembering which carry a change
	type line struct {
		text    string
		changed bool
	}
	var lines []line
	var cur strings.Builder
	curW, changed := 0, false
	for _, c := range cells {
		if curW > 0 && curW+1+c.w > width {
			lines = append(lines, line{cur.String(), changed})
			cur.Reset()
			curW, changed = 0, false
		}
		if curW > 0 {
			cur.WriteByte(' ')
			curW++
		}
		cur.WriteString(c.text)
		curW += c.w
		changed = changed || c.changed
	}
	if curW > 0 {
		lines = append(lines, line{cur.String(), changed})
	}
	keep := make([]bool, len(lines))
	for i, l := range lines {
		if !l.changed {
			continue
		}
		for k := max(0, i-ContextLines); k <= min(len(lines)-1, i+ContextLines); k++ {
			keep[k] = true
		}
	}
	var out []string
	gap := false
	for i, l := range lines {
		if !keep[i] {
			gap = true
			continue
		}
		if gap {
			out = append(out, u.S(Muted, u.G.Ellipsis))
		}
		gap = false
		out = append(out, l.text)
	}
	if gap && len(out) > 0 {
		out = append(out, u.S(Muted, u.G.Ellipsis))
	}
	return out
}

// diffWords is a Myers diff over words: the shortest edit script, removals before additions at each change.
func diffWords(a, b []string) []wordOp {
	n, m := len(a), len(b)
	maxD := n + m
	if maxD == 0 {
		return nil
	}
	off := maxD
	v := make([]int, 2*maxD+2)
	var trace [][]int
	for d := 0; d <= maxD; d++ {
		trace = append(trace, append([]int(nil), v...))
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = v[off+k+1]
			} else {
				x = v[off+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x++
				y++
			}
			v[off+k] = x
			if x >= n && y >= m {
				return backtrack(trace, a, b, off, d)
			}
		}
	}
	return nil
}

func backtrack(trace [][]int, a, b []string, off, d int) []wordOp {
	x, y := len(a), len(b)
	var rev []wordOp
	for ; d > 0; d-- {
		v := trace[d]
		k := x - y
		var prevK int
		if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
			prevK = k + 1
		} else {
			prevK = k - 1
		}
		prevX := v[off+prevK]
		prevY := prevX - prevK
		for x > prevX && y > prevY {
			rev = append(rev, wordOp{0, a[x-1]})
			x--
			y--
		}
		if x == prevX {
			rev = append(rev, wordOp{1, b[y-1]})
			y--
		} else {
			rev = append(rev, wordOp{-1, a[x-1]})
			x--
		}
	}
	for x > 0 && y > 0 {
		rev = append(rev, wordOp{0, a[x-1]})
		x--
		y--
	}
	out := make([]wordOp, len(rev))
	for i, o := range rev {
		out[len(rev)-1-i] = o
	}
	return out
}

// EventStatus is how an event line is marked (12.10, events tail).
type EventStatus int

// The statuses.
const (
	EventStarted EventStatus = iota
	EventSucceeded
	EventFailed
	EventReset
	EventInfo
)

// EventLine writes one line of a stream of events: `14:02:11  ● started    3f9c2e7b…5c60  REVIEWER01@live (v7)`.
// The time is the local clock time on a terminal and RFC 3339 otherwise (18.2: no relative or partial times for
// machines).
func (u *UI) EventLine(w io.Writer, at timeLike, status EventStatus, word string, fields ...string) {
	s := u.Out
	var glyph string
	var role Role
	switch status {
	case EventStarted:
		glyph, role = u.G.Active, Accent
	case EventSucceeded:
		glyph, role = u.G.Success, Success
	case EventFailed:
		glyph, role = u.G.Failure, Error
	case EventReset:
		glyph, role = u.G.Warning, Warning
	default:
		glyph, role = u.G.Bullet, Muted
	}
	stamp := at.Format("15:04:05")
	if !u.IO.IsStdoutTTY() {
		stamp = at.Format("2006-01-02T15:04:05Z07:00")
	}
	parts := []string{s.Paint(Muted, stamp), s.Paint(role, glyph) + " " + fmt.Sprintf("%-10s", word)}
	for _, f := range fields {
		if f != "" {
			parts = append(parts, f)
		}
	}
	line := strings.Join(parts, "  ")
	if status == EventReset {
		line = s.Paint(Muted, stamp) + "  " + s.Paint(Warning, glyph+" "+fmt.Sprintf("%-10s", word)+"  "+strings.Join(fields, "  "))
	}
	fmt.Fprintln(w, strings.TrimRight(line, " "))
}

type timeLike interface{ Format(string) string }

// ShortID shortens a long identifier for a terminal: its first 8 and last 4 characters (`3f9c2e7b…5c60`). Short
// identifiers, and every identifier when stdout isn't a terminal, are kept whole.
func (u *UI) ShortID(id string) string {
	if !u.IO.IsStdoutTTY() || len(id) <= 16 {
		return id
	}
	plain := strings.ReplaceAll(id, "-", "")
	if len(plain) < 16 {
		return id
	}
	return plain[:8] + u.G.Ellipsis + plain[len(plain)-4:]
}

// Empty says what is empty and how to fill it (12.9), on stderr: `No documents in /policies/ yet.` then the command
// that adds one.
func (u *UI) Empty(what, add string) {
	fmt.Fprintf(u.IO.ErrOut, "No %s yet.\n", what)
	if add != "" {
		u.Nextf("Add one: %s", add)
	}
}
