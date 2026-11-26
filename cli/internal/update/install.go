package update

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The install methods (8.4).
const (
	MethodScript    = "script"
	MethodArchive   = "archive"
	MethodHomebrew  = "homebrew"
	MethodScoop     = "scoop"
	MethodDeb       = "deb"
	MethodRPM       = "rpm"
	MethodGo        = "go"
	MethodContainer = "container"
)

// MethodEnv names the install method outright. The container image sets it; it outranks the receipt.
const MethodEnv = "CAITLYN_INSTALL_METHOD"

// Receipt is ~/.caitlyn/install.json, written by install.sh and install.ps1.
type Receipt struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Channel string `json:"channel,omitempty"`
	Version string `json:"version,omitempty"`
	Date    string `json:"installed,omitempty"`
}

// Install is how the running binary was installed, and how that was decided.
type Install struct {
	Method string
	// Source is what decided it: CAITLYN_INSTALL_METHOD, install.json, or the path check that matched.
	Source string
	// Channel from the receipt, when it names one.
	Channel string
}

// SelfUpdates reports whether `caitlyn update` replaces the binary itself: the install script or an archive.
func (i Install) SelfUpdates() bool { return i.Method == MethodScript || i.Method == MethodArchive }

// ManagerCommand is what updates a package-managed install, for `caitlyn update` to print instead (8.4). version is
// the newer release, for the container image's tag.
func (i Install) ManagerCommand(version string) string {
	switch i.Method {
	case MethodHomebrew:
		return "brew upgrade caitlyn"
	case MethodScoop:
		return "scoop update caitlyn"
	case MethodDeb:
		return "sudo apt-get update && sudo apt-get install --only-upgrade caitlyn"
	case MethodRPM:
		return "sudo dnf upgrade caitlyn"
	case MethodGo:
		return "go install github.com/caitlyn-ai/sdk/cli/cmd/caitlyn@latest"
	case MethodContainer:
		tag := "latest"
		if version != "" {
			tag = version
		}
		return "docker pull ghcr.io/caitlyn-ai/caitlyn:" + tag
	}
	return "caitlyn update"
}

// Probe is what install detection reads (tests give their own).
type Probe struct {
	Exe        string
	ConfigDir  string
	Lookup     func(string) (string, bool)
	ReadFile   func(string) ([]byte, error)
	FileExists func(string) bool
}

func (p Probe) read(path string) ([]byte, error) {
	if p.ReadFile != nil {
		return p.ReadFile(path)
	}
	return os.ReadFile(path)
}

func (p Probe) exists(path string) bool {
	if p.FileExists != nil {
		return p.FileExists(path)
	}
	_, err := os.Stat(path)
	return err == nil
}

func (p Probe) env(k string) string {
	if p.Lookup == nil {
		return ""
	}
	v, _ := p.Lookup(k)
	return v
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ca, cb := filepath.Clean(a), filepath.Clean(b)
	if ra, err := filepath.EvalSymlinks(ca); err == nil {
		ca = ra
	}
	if rb, err := filepath.EvalSymlinks(cb); err == nil {
		cb = rb
	}
	return strings.EqualFold(ca, cb) && (ca == cb || os.PathSeparator == '\\')
}

// DetectInstall decides how the binary was installed: CAITLYN_INSTALL_METHOD; then the receipt, when it names this
// binary; then its path (a Homebrew Cellar, a Scoop folder, a file dpkg or rpm owns, a Go bin folder). A binary
// none of these claim was unpacked from an archive, and updates itself.
func DetectInstall(p Probe) Install {
	if m := strings.ToLower(p.env(MethodEnv)); m != "" {
		return Install{Method: m, Source: MethodEnv}
	}
	if b, err := p.read(filepath.Join(p.ConfigDir, "install.json")); err == nil {
		var r Receipt
		if json.Unmarshal(b, &r) == nil && r.Method != "" && (r.Path == "" || samePath(r.Path, p.Exe)) {
			return Install{Method: strings.ToLower(r.Method), Source: "install.json", Channel: r.Channel}
		}
	}
	exe := filepath.ToSlash(p.Exe)
	lower := strings.ToLower(exe)
	switch {
	case strings.Contains(exe, "/Cellar/") || strings.Contains(lower, "/homebrew/") || strings.Contains(lower, "/linuxbrew/"):
		return Install{Method: MethodHomebrew, Source: "a Homebrew path"}
	case strings.Contains(lower, "/scoop/apps/") || strings.Contains(lower, "/scoop/shims/"):
		return Install{Method: MethodScoop, Source: "a Scoop path"}
	}
	if b, err := p.read("/var/lib/dpkg/info/caitlyn.list"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if samePath(strings.TrimSpace(line), p.Exe) {
				return Install{Method: MethodDeb, Source: "dpkg owns it"}
			}
		}
	}
	if (exe == "/usr/bin/caitlyn" || exe == "/usr/local/bin/caitlyn") && p.exists("/var/lib/rpm") && !p.exists("/var/lib/dpkg/info/caitlyn.list") && p.exists("/usr/share/doc/caitlyn") {
		return Install{Method: MethodRPM, Source: "an rpm path"}
	}
	dir := filepath.Dir(p.Exe)
	for _, gobin := range []string{p.env("GOBIN"), filepath.Join(p.env("GOPATH"), "bin"), filepath.Join(p.env("HOME"), "go", "bin")} {
		if gobin != "" && gobin != "bin" && samePath(dir, gobin) {
			return Install{Method: MethodGo, Source: "a Go bin folder"}
		}
	}
	return Install{Method: MethodArchive, Source: "no package manager claims it"}
}

// NoticeState is ~/.caitlyn/update/check.json: when the channel was last read, what it said, and when the person
// was last told.
type NoticeState struct {
	CheckedAt  time.Time `json:"checked_at,omitzero"`
	Channel    string    `json:"channel,omitempty"`
	Latest     string    `json:"latest,omitempty"`
	NotifiedAt time.Time `json:"notified_at,omitzero"`
	Notified   string    `json:"notified,omitempty"`
}

// CheckInterval is how often the notice reads the channel: once a day.
const CheckInterval = 24 * time.Hour

func noticePath(dir string) string { return filepath.Join(dir, "update", "check.json") }

// LoadNotice reads the notice state from the user folder.
func LoadNotice(configDir string) NoticeState {
	var s NoticeState
	if b, err := os.ReadFile(noticePath(configDir)); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

// SaveNotice writes it.
func SaveNotice(configDir string, s NoticeState) error {
	p := noticePath(configDir)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(s)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Due reports whether the channel should be read again.
func (s NoticeState) Due(now time.Time, channel string) bool {
	return s.CheckedAt.IsZero() || now.Sub(s.CheckedAt) >= CheckInterval || s.Channel != channel
}

// ShouldNotify reports whether to print the notice now: a newer release is known, and the person hasn't been told
// about it in the last day.
func (s NoticeState) ShouldNotify(now time.Time, current string) bool {
	if s.Latest == "" || !Newer(s.Latest, current) {
		return false
	}
	return s.Notified != s.Latest || now.Sub(s.NotifiedAt) >= CheckInterval
}

// Applied is ~/.caitlyn/update/applied.json: the note an update leaves, which the next run checks (8.4 step 6).
type Applied struct {
	From string    `json:"from"`
	To   string    `json:"to"`
	At   time.Time `json:"at"`
}

func appliedPath(dir string) string { return filepath.Join(dir, "update", "applied.json") }

// SaveApplied records an update.
func SaveApplied(configDir string, a Applied) error {
	p := appliedPath(configDir)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(a)
	return os.WriteFile(p, b, 0o600)
}

// TakeApplied reads and removes the note, if there is one.
func TakeApplied(configDir string) (Applied, bool) {
	var a Applied
	b, err := os.ReadFile(appliedPath(configDir))
	if err != nil {
		return a, false
	}
	_ = os.Remove(appliedPath(configDir))
	return a, json.Unmarshal(b, &a) == nil
}
