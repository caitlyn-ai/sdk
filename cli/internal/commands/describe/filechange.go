package describe

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/textdiff"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// FileChange is one file the CLI would write into a project for AI coding tools: what is there now and what it
// would be. An After of "" with Delete removes the file.
type FileChange struct {
	// Path is the file; Root the project folder it is shown relative to.
	Path, Root    string
	Before, After string
	// Exists is whether the file is there now; Delete whether the change removes it.
	Exists, Delete bool
}

// Rel is the file as people are shown it: relative to Root, with forward slashes.
func (c *FileChange) Rel() string {
	if c.Root != "" {
		if r, err := filepath.Rel(c.Root, c.Path); err == nil && !strings.HasPrefix(r, "..") {
			return filepath.ToSlash(r)
		}
	}
	return c.Path
}

// Action is create, change, delete, or "" when nothing would change.
func (c *FileChange) Action() string {
	switch {
	case c.Delete && c.Exists:
		return "delete"
	case c.Delete:
		return ""
	case !c.Exists && c.After == "":
		return ""
	case !c.Exists:
		return "create"
	case c.Before != c.After:
		return "change"
	}
	return ""
}

// Changed reports whether writing the change would change anything.
func (c *FileChange) Changed() bool { return c.Action() != "" }

// Diff is the change as a unified diff, "" when there is none.
func (c *FileChange) Diff() string {
	if !c.Changed() {
		return ""
	}
	return textdiff.Unified(c.Rel(), c.Before, c.After, !c.Exists, c.Delete)
}

// Counts are the lines the change adds and removes.
func (c *FileChange) Counts() (added, removed int) {
	return textdiff.Counts(c.Before, c.After)
}

// ReadFileChange reads the file as it is now, refusing a path that goes through a symbolic link under root: a cloned
// repository could otherwise point AGENTS.md at any file you own.
func ReadFileChange(root, path string) (*FileChange, error) {
	if err := CheckNoLinks(root, path); err != nil {
		return nil, err
	}
	c := &FileChange{Path: path, Root: root}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		c.Exists, c.Before, c.After = true, string(b), string(b)
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, cmdutil.FromError(err)
	}
	return c, nil
}

// CheckNoLinks refuses a path that is, or goes through, a symbolic link below root (root itself may be one).
func CheckNoLinks(root, path string) error {
	rel, err := filepath.Rel(root, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		rel = filepath.Base(path)
		root = filepath.Dir(path)
	}
	cur := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if err != nil {
			return nil // what doesn't exist yet can't be a link
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			e := cmdutil.Usagef("%s is a symbolic link, so nothing was written.", cur)
			e.Code = "SYMBOLIC_LINK_REFUSED"
			e.Detail = "The CLI only writes files that are really in the project: a link could point anywhere. Replace the link with the file, or make the change yourself."
			return e
		}
	}
	return nil
}

// Write makes the change: writes the file (and its folders), or removes it, and then any folders the removal left
// empty below the project's own folders.
func (c *FileChange) Write() error {
	if !c.Changed() {
		return nil
	}
	if err := CheckNoLinks(c.Root, c.Path); err != nil {
		return err
	}
	if c.Delete {
		if err := os.Remove(c.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return cmdutil.FromError(err)
		}
		// A folder directly in the project (.claude, .cursor, .github) stays: it may be how the project marks a tool
		for d := filepath.Dir(c.Path); c.Root != "" && d != c.Root && filepath.Dir(d) != c.Root && strings.HasPrefix(d, c.Root); d = filepath.Dir(d) {
			if os.Remove(d) != nil {
				break // not empty
			}
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(c.Path), 0o755); err != nil {
		return cmdutil.FromError(err)
	}
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(c.Path); err == nil {
		mode = fi.Mode().Perm()
	}
	if err := os.WriteFile(c.Path, []byte(c.After), mode); err != nil {
		return cmdutil.FromError(err)
	}
	return nil
}

// RenderDiff writes a unified diff for people: added lines in the added colour, removed in the removed colour, the
// file and hunk lines muted.
func RenderDiff(w io.Writer, u *ui.UI, diff string) {
	for _, l := range strings.Split(strings.TrimSuffix(diff, "\n"), "\n") {
		switch {
		case strings.HasPrefix(l, "+++ ") || strings.HasPrefix(l, "--- ") || strings.HasPrefix(l, "@@ "):
			fmt.Fprintln(w, u.S(ui.Muted, l))
		case strings.HasPrefix(l, "+"):
			fmt.Fprintln(w, u.S(ui.Added, l))
		case strings.HasPrefix(l, "-"):
			fmt.Fprintln(w, u.S(ui.Removed, l))
		default:
			fmt.Fprintln(w, l)
		}
	}
}
