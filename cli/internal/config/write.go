package config

import (
	"errors"
	"fmt"
	"github.com/gofrs/flock"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// Set writes key = value into the user file's top level, a profile's table (profile != ""), or the project file
// (project). The file is edited in place, line by line, so comments and layout are kept; only the key's own line
// changes, or a line is added at the end of its table. The result is parsed again before it is written, and the
// edit is refused if the file would not load.
func (c *Config) Set(key, value, profile string, project bool) error {
	k := KeyNamed(key)
	if k == nil && key != "default_profile" {
		return fmt.Errorf("%s is not a setting (caitlyn config list shows them all)", key)
	}
	if secretKeys[key] {
		return errors.New("secrets never go in a configuration file")
	}
	if key == "agent_scopes" {
		var list []string
		for _, p := range strings.Split(value, ",") {
			if p = strings.TrimSpace(p); p != "" {
				list = append(list, p)
			}
		}
		if err := CheckAgentScopes(list); err != nil {
			return fmt.Errorf("agent_scopes: %w", err)
		}
	}
	path, table := c.UserPath, ""
	if project {
		if k == nil || !k.Project {
			return fmt.Errorf("%s may only be set in your user file, because a project file must not choose %s", key, whyUserOnly(key))
		}
		path = c.ProjectPath
		if path == "" {
			wd := c.opts.WorkDir
			path = filepath.Join(wd, ".caitlyn.toml")
		}
	} else if profile != "" {
		table = "profiles." + quoteKey(profile)
	}
	if i := strings.LastIndex(key, "."); i >= 0 {
		// apply.paths lives in [apply] (or [profiles.x.apply]); traces.otlp_endpoint in [traces]
		if table != "" {
			table += "."
		}
		table += key[:i]
		key = key[i+1:]
	}
	lit, err := literal(k, value)
	if err != nil {
		return err
	}
	return c.editFile(path, table, key, &lit)
}

// Unset removes key from the user file's top level, a profile, or the project file.
func (c *Config) Unset(key, profile string, project bool) error {
	if KeyNamed(key) == nil && key != "default_profile" {
		return fmt.Errorf("%s is not a setting", key)
	}
	path, table := c.UserPath, ""
	if project {
		path = c.ProjectPath
		if path == "" {
			return errors.New("there is no project file")
		}
	} else if profile != "" {
		table = "profiles." + quoteKey(profile)
	}
	if i := strings.LastIndex(key, "."); i >= 0 {
		if table != "" {
			table += "."
		}
		table += key[:i]
		key = key[i+1:]
	}
	return c.editFile(path, table, key, nil)
}

// SetProfile writes several keys into one profile at once (sign-in saves the workspace, auth mode and outputs).
func (c *Config) SetProfile(profile string, values map[string]string) error {
	for _, key := range sortedKeys(values) {
		if err := c.Set(key, values[key], profile, false); err != nil {
			return err
		}
	}
	return nil
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	// workspace first, so a new profile's table reads naturally
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if less(out[j], out[i]) {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func less(a, b string) bool {
	if a == "workspace" || b == "workspace" {
		return a == "workspace"
	}
	return a < b
}

var bareKey = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func quoteKey(k string) string {
	if bareKey.MatchString(k) {
		return k
	}
	return strconv.Quote(k)
}

func literal(k *Key, value string) (string, error) {
	if k != nil && k.List {
		var items []string
		for _, p := range strings.Split(value, ",") {
			if p = strings.TrimSpace(p); p != "" {
				items = append(items, strconv.Quote(p))
			}
		}
		// agent_scopes takes a preset ("read-only") or a list
		if k.Name == "agent_scopes" && len(items) == 1 {
			switch strings.Trim(items[0], `"`) {
			case "read-only", "full", "none":
				return items[0], nil
			}
		}
		return "[" + strings.Join(items, ", ") + "]", nil
	}
	switch strings.ToLower(value) {
	case "true", "false":
		if k != nil && (k.Default == "true" || k.Default == "false") {
			return strings.ToLower(value), nil
		}
	}
	return strconv.Quote(value), nil
}

var headerRE = regexp.MustCompile(`^\s*\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$`)

// editFile sets (lit != nil) or removes key in table ("" is the top level), under a lock in the configuration
// folder, so concurrent writers (auth login, config set, update --channel) never lose each other's changes.
func (c *Config) editFile(path, table, key string, lit *string) error {
	if err := os.MkdirAll(c.Dir(), 0o700); err != nil {
		return err
	}
	l := flock.New(filepath.Join(c.Dir(), ".lock-config"))
	if err := l.Lock(); err != nil {
		return fmt.Errorf("the configuration's lock could not be taken: %w", err)
	}
	defer func() { _ = l.Unlock() }()
	return editFile(path, table, key, lit, path == c.ProjectPath || filepath.Base(path) == ".caitlyn.toml")
}

// editFile sets (lit != nil) or removes key in table ("" is the top level). A project file that is a symbolic link
// is refused: a cloned repository could otherwise point .caitlyn.toml at any file you own. Your own user file may
// be a link (stow, chezmoi, home-manager): the file it points to is edited, with the temporary file beside it.
func editFile(path, table, key string, lit *string, project bool) error {
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		if project {
			return fmt.Errorf("%s is a symbolic link, so it wasn't changed: edit the file it points to yourself", path)
		}
		target, err := filepath.EvalSymlinks(path)
		if err != nil {
			return err
		}
		path = target
	}
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	out, changed, err := editText(string(b), table, key, lit, path)
	if err != nil || !changed {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return replaceFile(path, out)
}

// SetProjectText is a project file's text with key = value set, as config set --project writes it: for showing the
// change before it is made (caitlyn ai setup). Only keys a project file may hold are accepted.
func SetProjectText(text, key, value string) (string, error) {
	k := KeyNamed(key)
	if k == nil || !k.Project {
		return "", fmt.Errorf("%s may not be set in a project file", key)
	}
	lit, err := literal(k, value)
	if err != nil {
		return "", err
	}
	out, _, err := editText(text, "", key, &lit, ".caitlyn.toml")
	return out, err
}

// editText sets (lit != nil) or removes key in table ("" is the top level) of a TOML file's text, line by line, and
// checks the result still parses. changed is false when there is nothing to remove.
func editText(text, table, key string, lit *string, path string) (out string, changed bool, err error) {
	b := []byte(text)
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(b) == 0 {
		lines = nil
	}
	keyRE := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=`)
	current := ""
	start, end := -1, -1 // the table's body: lines (start, end]
	if table == "" {
		start = -1
		end = len(lines) - 1
		for i, l := range lines {
			if headerRE.MatchString(l) {
				end = i - 1
				break
			}
		}
	}
	for i, l := range lines {
		if m := headerRE.FindStringSubmatch(l); m != nil {
			current = normaliseTable(m[1])
			if table != "" && current == normaliseTable(table) {
				start = i
				end = len(lines) - 1
				for j := i + 1; j < len(lines); j++ {
					if headerRE.MatchString(lines[j]) {
						end = j - 1
						break
					}
				}
			}
		}
	}
	found := -1
	if table == "" || start >= 0 {
		for i := start + 1; i <= end && i < len(lines); i++ {
			if keyRE.MatchString(lines[i]) {
				found = i
				break
			}
		}
	}
	// A value spread over several lines (an array or a multi-line string) can't be edited line by line
	if found >= 0 {
		v := strings.TrimSpace(lines[found][strings.Index(lines[found], "=")+1:])
		if (strings.HasPrefix(v, "[") && strings.Count(v, "[") > strings.Count(v, "]")) || strings.HasPrefix(v, `"""`) || strings.HasPrefix(v, "'''") {
			return "", false, fmt.Errorf("%s in %s spans several lines, which config can't edit: put it on one line (%s = [\"a\", \"b\"]) or edit the file yourself", key, path, key)
		}
	}
	switch {
	case lit == nil && found >= 0:
		lines = append(lines[:found], lines[found+1:]...)
	case lit == nil:
		return text, false, nil
	case found >= 0:
		lines[found] = key + " = " + *lit
	case table == "" || start >= 0:
		// after the table's last non-blank line
		at := end
		for at > start && at >= 0 && strings.TrimSpace(lines[at]) == "" {
			at--
		}
		ins := key + " = " + *lit
		lines = append(lines[:at+1], append([]string{ins}, lines[at+1:]...)...)
	default:
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
			lines = append(lines, "")
		}
		lines = append(lines, "["+table+"]", key+" = "+*lit)
	}
	out = strings.Join(lines, "\n") + "\n"
	var check map[string]any
	if err := toml.Unmarshal([]byte(out), &check); err != nil {
		return "", false, fmt.Errorf("%s would not be valid TOML after this change, so it was left as it was: %w", path, err)
	}
	return out, true, nil
}

// replaceFile writes out over path through a new file of its own, keeping path's mode (0600 for a new file).
func replaceFile(path, out string) error {
	mode := os.FileMode(0o600)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	// A new file of our own (O_EXCL: never an existing file or link), then renamed over the old one
	f, err := os.CreateTemp(filepath.Dir(path), ".caitlyn-config-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.WriteString(out); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func normaliseTable(t string) string {
	parts := strings.Split(t, ".")
	for i, p := range parts {
		parts[i] = strings.Trim(strings.TrimSpace(p), `"`)
	}
	return strings.Join(parts, ".")
}
