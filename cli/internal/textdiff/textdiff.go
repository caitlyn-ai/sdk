// Package textdiff compares two versions of a text file line by line: a unified diff, as git prints one, for the
// files the CLI writes into a project (caitlyn ai setup, caitlyn help agents --write), and the lines added and
// removed. It is for small files: a pair too large to compare line by line is shown as a whole replacement.
package textdiff

import (
	"fmt"
	"strings"
)

// maxCells bounds the comparison's table (lines before × lines after).
const maxCells = 4_000_000

// Op is one line of the comparison: kept (' '), added ('+') or removed ('-').
type Op struct {
	Kind byte
	Text string
}

// Lines compares a and b line by line (longest common subsequence). A text that ends with a newline has no empty
// last line.
func Lines(a, b string) []Op {
	al, bl := split(a), split(b)
	n, m := len(al), len(bl)
	if n*m > maxCells {
		var out []Op
		for _, l := range al {
			out = append(out, Op{'-', l})
		}
		for _, l := range bl {
			out = append(out, Op{'+', l})
		}
		return out
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
	var out []Op
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case al[i] == bl[j]:
			out = append(out, Op{' ', al[i]})
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			out = append(out, Op{'-', al[i]})
			i++
		default:
			out = append(out, Op{'+', bl[j]})
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, Op{'-', al[i]})
	}
	for ; j < m; j++ {
		out = append(out, Op{'+', bl[j]})
	}
	return out
}

func split(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(s, "\n"), "\n")
}

// Counts is the number of lines added and removed.
func Counts(a, b string) (added, removed int) {
	for _, op := range Lines(a, b) {
		switch op.Kind {
		case '+':
			added++
		case '-':
			removed++
		}
	}
	return added, removed
}

// Unified is a unified diff of a file from a to b, with three lines of context, named a/<name> and b/<name> as git
// names them (/dev/null for a file that doesn't exist on one side: created reports whether a is new, deleted whether
// b is gone). It is "" when the two are the same.
func Unified(name, a, b string, created, deleted bool) string {
	if a == b && !created && !deleted {
		return ""
	}
	ops := Lines(a, b)
	from, to := "a/"+name, "b/"+name
	if created {
		from = "/dev/null"
	}
	if deleted {
		to = "/dev/null"
	}
	var out strings.Builder
	fmt.Fprintf(&out, "--- %s\n+++ %s\n", from, to)
	const context = 3
	// Hunks: runs of changes with up to three lines either side, joined when their context touches
	k := 0
	for k < len(ops) {
		if ops[k].Kind == ' ' {
			k++
			continue
		}
		start := max(0, k-context)
		end := k
		for end < len(ops) {
			if ops[end].Kind != ' ' {
				end++
				continue
			}
			// a run of kept lines: the hunk ends unless another change follows within 2×context
			run := end
			for run < len(ops) && ops[run].Kind == ' ' {
				run++
			}
			if run == len(ops) || run-end > 2*context {
				end = min(len(ops), end+context)
				break
			}
			end = run
		}
		// Line numbers at the hunk's start
		aLine, bLine := 1, 1
		for _, op := range ops[:start] {
			if op.Kind != '+' {
				aLine++
			}
			if op.Kind != '-' {
				bLine++
			}
		}
		aCount, bCount := 0, 0
		for _, op := range ops[start:end] {
			if op.Kind != '+' {
				aCount++
			}
			if op.Kind != '-' {
				bCount++
			}
		}
		if aCount == 0 {
			aLine--
		}
		if bCount == 0 {
			bLine--
		}
		fmt.Fprintf(&out, "@@ -%s +%s @@\n", rangeOf(aLine, aCount), rangeOf(bLine, bCount))
		for _, op := range ops[start:end] {
			out.WriteByte(op.Kind)
			out.WriteString(op.Text)
			out.WriteByte('\n')
		}
		k = end
	}
	return out.String()
}

func rangeOf(line, count int) string {
	if count == 1 {
		return fmt.Sprint(line)
	}
	return fmt.Sprintf("%d,%d", line, count)
}
