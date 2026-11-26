package update

import (
	"fmt"
	"strconv"
	"strings"
)

// Version is a semantic version: 0.12.0, 0.13.0-beta.3.
type Version struct {
	Major, Minor, Patch int
	Pre                 []string
	raw                 string
}

// ParseVersion reads X.Y.Z with an optional -prerelease (and +build, ignored); a leading v is allowed.
func ParseVersion(s string) (Version, error) {
	raw := strings.TrimPrefix(strings.TrimSpace(s), "v")
	core := raw
	if i := strings.IndexByte(core, '+'); i >= 0 {
		core = core[:i]
	}
	var pre string
	if i := strings.IndexByte(core, '-'); i >= 0 {
		core, pre = core[:i], core[i+1:]
		if pre == "" {
			return Version{}, fmt.Errorf("%q is not a version like 0.12.0", s)
		}
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return Version{}, fmt.Errorf("%q is not a version like 0.12.0", s)
	}
	var n [3]int
	for i, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil || v < 0 || (len(p) > 1 && p[0] == '0') {
			return Version{}, fmt.Errorf("%q is not a version like 0.12.0", s)
		}
		n[i] = v
	}
	v := Version{Major: n[0], Minor: n[1], Patch: n[2], raw: raw}
	if pre != "" {
		v.Pre = strings.Split(pre, ".")
		for _, id := range v.Pre {
			if id == "" {
				return Version{}, fmt.Errorf("%q is not a version like 0.12.0", s)
			}
		}
	}
	return v, nil
}

// String is the version as given, without a leading v.
func (v Version) String() string {
	if v.raw != "" {
		return v.raw
	}
	s := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if len(v.Pre) > 0 {
		s += "-" + strings.Join(v.Pre, ".")
	}
	return s
}

// Compare is -1, 0 or 1, by semantic-versioning precedence: a prerelease is older than its release.
func (v Version) Compare(o Version) int {
	for _, d := range [][2]int{{v.Major, o.Major}, {v.Minor, o.Minor}, {v.Patch, o.Patch}} {
		if d[0] != d[1] {
			if d[0] < d[1] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(v.Pre) == 0 && len(o.Pre) == 0:
		return 0
	case len(v.Pre) == 0:
		return 1
	case len(o.Pre) == 0:
		return -1
	}
	for i := 0; i < len(v.Pre) && i < len(o.Pre); i++ {
		a, b := v.Pre[i], o.Pre[i]
		ai, aerr := strconv.Atoi(a)
		bi, berr := strconv.Atoi(b)
		switch {
		case aerr == nil && berr == nil:
			if ai != bi {
				if ai < bi {
					return -1
				}
				return 1
			}
		case aerr == nil:
			return -1
		case berr == nil:
			return 1
		default:
			if c := strings.Compare(a, b); c != 0 {
				return c
			}
		}
	}
	switch {
	case len(v.Pre) < len(o.Pre):
		return -1
	case len(v.Pre) > len(o.Pre):
		return 1
	}
	return 0
}

// Newer reports whether candidate is newer than current. An unreadable current version (a development build)
// counts as older than any release.
func Newer(candidate, current string) bool {
	c, err := ParseVersion(candidate)
	if err != nil {
		return false
	}
	cur, err := ParseVersion(current)
	if err != nil {
		return true
	}
	return c.Compare(cur) > 0
}
