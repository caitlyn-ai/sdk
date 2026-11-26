// Package shellwords splits a command-line setting (pager, editor, browser) into a program and its arguments,
// honouring quotes, so a program under a path with spaces works: `"C:\Program Files\Git\usr\bin\less.exe" -R`.
// Backslashes are kept as they are (they are Windows path separators), except before a double quote inside double
// quotes.
package shellwords

import "strings"

// Split returns the words of s; nil when s is empty or only spaces ("not configured").
func Split(s string) []string {
	var words []string
	var cur strings.Builder
	in := false
	var quote rune
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case quote != 0 && r == quote:
			quote = 0
		case quote == '"' && r == '\\' && i+1 < len(runes) && runes[i+1] == '"':
			cur.WriteRune('"')
			i++
		case quote != 0:
			cur.WriteRune(r)
		case r == '"' || r == '\'':
			quote, in = r, true
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			if in {
				words = append(words, cur.String())
				cur.Reset()
				in = false
			}
		default:
			cur.WriteRune(r)
			in = true
		}
	}
	if in {
		words = append(words, cur.String())
	}
	return words
}
