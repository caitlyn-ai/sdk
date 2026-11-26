// Package useragent puts a name into the form the user agent's ci/ and agent/ tokens take (PROTOCOL.md 3.2: 1 to 32
// of a-z, 0-9 and -), which usage data for Caitlyn also uses, so the two always carry the same value.
package useragent

import "strings"

// MaxLen is the longest a token may be.
const MaxLen = 32

// Token lower-cases name, turns every other character into -, and cuts the result to MaxLen. A name with no letter
// or digit is "" (the caller then leaves the token out, or says unknown).
func Token(name string) string {
	var b strings.Builder
	valid := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		if b.Len() >= MaxLen {
			break // the loop's, not a switch's: the cap ends the name
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			valid = true
		} else {
			b.WriteByte('-')
		}
	}
	if !valid {
		return ""
	}
	return b.String()
}
