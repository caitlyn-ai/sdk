package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"aead.dev/minisign"
)

// release is a test release server: a key pair made for the test, a channel pointer, a signed manifest and an
// archive. Nothing here is or touches a real signing key.
type release struct {
	srv       *httptest.Server
	pub       string
	priv      minisign.PrivateKey
	files     map[string][]byte
	downloads atomic.Int32
}

func newRelease(t *testing.T) *release {
	t.Helper()
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pk, _ := pub.MarshalText()
	r := &release{pub: string(pk), priv: priv, files: map[string][]byte{}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		b, ok := r.files[strings.TrimPrefix(req.URL.Path, "/cli/")]
		if !ok {
			http.NotFound(w, req)
			return
		}
		if strings.HasSuffix(req.URL.Path, ".tar.gz") || strings.HasSuffix(req.URL.Path, ".zip") {
			r.downloads.Add(1)
		}
		_, _ = w.Write(b)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func tarGz(t *testing.T, name string, body []byte) []byte {
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	for _, f := range []struct {
		name string
		body []byte
	}{{"LICENSE", []byte("licence")}, {name, body}} {
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o755, Size: int64(len(f.body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write(f.body)
	}
	tw.Close()
	gz.Close()
	return b.Bytes()
}

func zipOf(t *testing.T, name string, body []byte) []byte {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	w, _ := zw.Create(name)
	_, _ = w.Write(body)
	zw.Close()
	return b.Bytes()
}

// publish adds a release for linux/amd64 (and windows/amd64), signed with the test key, and points channel at it.
func (r *release) publish(t *testing.T, version, channel string, body []byte) {
	t.Helper()
	arch := tarGz(t, "caitlyn", body)
	win := zipOf(t, "caitlyn.exe", body)
	sum := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
	name := "caitlyn_" + version + "_linux_amd64.tar.gz"
	wname := "caitlyn_" + version + "_windows_amd64.zip"
	m := Manifest{Version: version, Channel: channel, Date: "2026-11-25", Platforms: []Platform{
		{OS: "linux", Arch: "amd64", URL: name, Size: int64(len(arch)), SHA256: sum(arch)},
		{OS: "windows", Arch: "amd64", URL: wname, Size: int64(len(win)), SHA256: sum(win)},
	}}
	mb, _ := json.Marshal(m)
	dir := version + "/"
	r.files[dir+"manifest.json"] = mb
	r.files[dir+"manifest.json.minisig"] = minisign.Sign(r.priv, mb)
	r.files[dir+name] = arch
	r.files[dir+wname] = win
	if channel != "" {
		p, _ := json.Marshal(ChannelPointer{Version: version, Manifest: dir + "manifest.json"})
		r.files["channels/"+channel+".json"] = p
	}
}

// binary is a fake binary's content; the start check reads the version out of it.
func binary(version string) []byte { return []byte("#!caitlyn " + version + "\n") }

func versionOf(_ context.Context, path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := strings.TrimSpace(string(b))
	if !strings.HasPrefix(s, "#!caitlyn ") {
		return "", errors.New("exec format error")
	}
	return strings.TrimPrefix(s, "#!caitlyn "), nil
}

func (r *release) updater(t *testing.T) *Updater {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "caitlyn")
	if err := os.WriteFile(exe, binary("0.12.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &Updater{BaseURL: r.srv.URL + "/cli/", PublicKey: r.pub, Exe: exe, GOOS: "linux", GOARCH: "amd64", StartCheck: versionOf}
}

func read(t *testing.T, p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return "<" + err.Error() + ">"
	}
	return string(b)
}

func code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func TestGoodUpdate(t *testing.T) {
	r := newRelease(t)
	r.publish(t, "0.13.0", "stable", binary("0.13.0"))
	u := r.updater(t)
	rel, err := u.Latest(context.Background(), "stable")
	if err != nil {
		t.Fatal(err)
	}
	if err := u.Apply(context.Background(), rel); err != nil {
		t.Fatal(err)
	}
	if read(t, u.Exe) != string(binary("0.13.0")) || read(t, PreviousPath(u.Exe)) != string(binary("0.12.0")) {
		t.Fatal("the new binary is in place and the old one kept as caitlyn.previous")
	}
	st, _ := os.Stat(u.Exe)
	if st.Mode().Perm()&0o100 == 0 {
		t.Fatal("the new binary is executable")
	}
	entries, _ := os.ReadDir(filepath.Dir(u.Exe))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".caitlyn-") {
			t.Fatalf("temporary file left: %s", e.Name())
		}
	}
	// Rollback, and rollback again (which undoes it)
	if err := u.Rollback(); err != nil {
		t.Fatal(err)
	}
	if read(t, u.Exe) != string(binary("0.12.0")) || read(t, PreviousPath(u.Exe)) != string(binary("0.13.0")) {
		t.Fatal("--rollback restores the previous binary")
	}
	_ = u.Rollback()
	if read(t, u.Exe) != string(binary("0.13.0")) {
		t.Fatal("a second rollback undoes the first")
	}
}

func TestRollbackWithNoPrevious(t *testing.T) {
	r := newRelease(t)
	u := r.updater(t)
	if err := u.Rollback(); code(err) != CodeNoPrevious {
		t.Fatalf("got %v", err)
	}
	if read(t, u.Exe) != string(binary("0.12.0")) {
		t.Fatal("the binary is untouched")
	}
}

func TestRefusals(t *testing.T) {
	cases := []struct {
		name   string
		tamper func(t *testing.T, r *release)
		key    func(r *release) string
		code   string
	}{
		{"tampered archive", func(t *testing.T, r *release) {
			b := r.files["0.13.0/caitlyn_0.13.0_linux_amd64.tar.gz"]
			c := append([]byte(nil), b...)
			c[len(c)/2] ^= 0xff
			r.files["0.13.0/caitlyn_0.13.0_linux_amd64.tar.gz"] = c
		}, nil, CodeChecksum},
		{"archive of another size", func(t *testing.T, r *release) {
			p := "0.13.0/caitlyn_0.13.0_linux_amd64.tar.gz"
			r.files[p] = append(r.files[p], 0)
		}, nil, CodeChecksum},
		{"manifest changed after signing", func(t *testing.T, r *release) {
			p := "0.13.0/manifest.json"
			r.files[p] = bytes.Replace(r.files[p], []byte(`"2026-11-25"`), []byte(`"2026-11-26"`), 1)
		}, nil, CodeSignature},
		{"missing signature", func(t *testing.T, r *release) { delete(r.files, "0.13.0/manifest.json.minisig") }, nil, CodeSignature},
		{"empty signature", func(t *testing.T, r *release) { r.files["0.13.0/manifest.json.minisig"] = nil }, nil, CodeSignature},
		{"signed by another key", func(t *testing.T, r *release) {
			_, other, _ := minisign.GenerateKey(rand.Reader)
			r.files["0.13.0/manifest.json.minisig"] = minisign.Sign(other, r.files["0.13.0/manifest.json"])
		}, nil, CodeSignature},
		{"the placeholder key", nil, func(*release) string { return PublicKey }, CodeSignature},
		{"a binary that doesn't start", func(t *testing.T, r *release) { r.publish(t, "0.13.0", "stable", []byte("garbage")) }, nil, CodeStartCheck},
		{"a binary that says another version", func(t *testing.T, r *release) { r.publish(t, "0.13.0", "stable", binary("0.11.0")) }, nil, CodeStartCheck},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRelease(t)
			r.publish(t, "0.13.0", "stable", binary("0.13.0"))
			if c.tamper != nil {
				c.tamper(t, r)
			}
			u := r.updater(t)
			if c.key != nil {
				u.PublicKey = c.key(r)
			}
			rel, err := u.Latest(context.Background(), "stable")
			if err == nil {
				err = u.Apply(context.Background(), rel)
			}
			if code(err) != c.code {
				t.Fatalf("got %v (%s), want %s", err, code(err), c.code)
			}
			if read(t, u.Exe) != string(binary("0.12.0")) {
				t.Fatal("the old binary must stay")
			}
			if _, err := os.Stat(PreviousPath(u.Exe)); err == nil {
				t.Fatal("nothing was swapped")
			}
			if strings.HasPrefix(c.code, "UPDATE_SIGNATURE") && r.downloads.Load() != 0 {
				t.Fatal("nothing is downloaded from an unverified manifest")
			}
		})
	}
}

// TestFailedStartCheckAfterSwapRollsBack: the binary passes the check beside it, but not once installed.
func TestFailedStartCheckAfterSwapRollsBack(t *testing.T) {
	r := newRelease(t)
	r.publish(t, "0.13.0", "stable", binary("0.13.0"))
	u := r.updater(t)
	calls := 0
	u.StartCheck = func(ctx context.Context, p string) (string, error) {
		calls++
		if calls == 2 {
			return "", errors.New("segmentation fault")
		}
		return versionOf(ctx, p)
	}
	rel, _ := u.Latest(context.Background(), "stable")
	err := u.Apply(context.Background(), rel)
	if code(err) != CodeRolledBack {
		t.Fatalf("got %v", err)
	}
	if read(t, u.Exe) != string(binary("0.12.0")) {
		t.Fatal("the previous binary is restored")
	}
}

func TestWindowsRenamePath(t *testing.T) {
	r := newRelease(t)
	r.publish(t, "0.13.0", "stable", binary("0.13.0"))
	u := r.updater(t)
	exe := filepath.Join(filepath.Dir(u.Exe), "caitlyn.exe")
	_ = os.Rename(u.Exe, exe)
	u.Exe, u.GOOS, u.Windows = exe, "windows", true
	rel, err := u.Latest(context.Background(), "stable")
	if err != nil {
		t.Fatal(err)
	}
	if err := u.Apply(context.Background(), rel); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(exe)
	if read(t, exe) != string(binary("0.13.0")) || read(t, filepath.Join(dir, "caitlyn.previous.exe")) != string(binary("0.12.0")) || read(t, exe+".old") != string(binary("0.12.0")) {
		t.Fatal("Windows: the running binary is renamed to .old, copied to caitlyn.previous.exe, and the new one moved in")
	}
	CleanupOld(exe)
	if _, err := os.Stat(exe + ".old"); err == nil {
		t.Fatal("the next run deletes the .old file")
	}
	if err := u.Rollback(); err != nil || read(t, exe) != string(binary("0.12.0")) {
		t.Fatalf("rollback on Windows: %v", err)
	}
}

func TestVersionAndPlatform(t *testing.T) {
	r := newRelease(t)
	r.publish(t, "0.11.0", "", binary("0.11.0"))
	u := r.updater(t)
	rel, err := u.Version(context.Background(), "0.11.0")
	if err != nil || rel.Manifest.Version != "0.11.0" {
		t.Fatalf("%v", err)
	}
	u.GOARCH = "riscv64"
	if _, err := u.Version(context.Background(), "0.11.0"); code(err) != CodeNoPlatform {
		t.Fatalf("got %v", err)
	}
	if _, err := u.Latest(context.Background(), "nightly"); err == nil {
		t.Fatal("an unknown channel is refused")
	}
	if _, err := u.Version(context.Background(), "9.9.9"); code(err) != CodeFetch {
		t.Fatalf("a release that doesn't exist: %v", err)
	}
}

func TestOnlyHTTPS(t *testing.T) {
	u := &Updater{BaseURL: "http://build.example/cli/"}
	if _, err := u.Pointer(context.Background(), "stable"); code(err) != CodeFetch || !strings.Contains(err.Error(), "https") {
		t.Fatalf("plain http (other than to this machine) is refused: %v", err)
	}
}

func TestSemver(t *testing.T) {
	order := []string{"0.9.0", "0.12.0-beta.1", "0.12.0-beta.2", "0.12.0-beta.10", "0.12.0-rc.1", "0.12.0", "0.12.1", "1.0.0"}
	for i := range order {
		for j := range order {
			a, _ := ParseVersion(order[i])
			b, _ := ParseVersion(order[j])
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := a.Compare(b); got != want {
				t.Errorf("%s vs %s: %d, want %d", order[i], order[j], got, want)
			}
		}
	}
	for _, bad := range []string{"", "1.2", "1.2.3.4", "01.2.3", "1.2.x", "1.2.3-"} {
		if _, err := ParseVersion(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
	if !Newer("0.13.0", "0.12.0") || Newer("0.12.0", "0.12.0") || Newer("0.11.0", "0.12.0") || !Newer("0.1.0", "dev") {
		t.Fatal("Newer")
	}
	if v, _ := ParseVersion("v0.12.0+abc"); v.String() != "0.12.0+abc" || v.Compare(Version{Major: 0, Minor: 12}) != 0 {
		t.Fatal("a leading v and build metadata")
	}
}

func TestDetectInstall(t *testing.T) {
	files := map[string]string{}
	probe := func(exe string, env map[string]string) Install {
		return DetectInstall(Probe{
			Exe: exe, ConfigDir: "/home/a/.caitlyn",
			Lookup: func(k string) (string, bool) { v, ok := env[k]; return v, ok },
			ReadFile: func(p string) ([]byte, error) {
				if b, ok := files[p]; ok {
					return []byte(b), nil
				}
				return nil, os.ErrNotExist
			},
			FileExists: func(p string) bool { _, ok := files[p]; return ok },
		})
	}
	cases := []struct {
		name, exe string
		env       map[string]string
		files     map[string]string
		want      string
	}{
		{"archive", "/home/a/bin/caitlyn", nil, nil, MethodArchive},
		{"Homebrew Cellar", "/opt/homebrew/Cellar/caitlyn/0.12.0/bin/caitlyn", nil, nil, MethodHomebrew},
		{"Linuxbrew", "/home/linuxbrew/.linuxbrew/bin/caitlyn", nil, nil, MethodHomebrew},
		{"Scoop", `C:/Users/a/scoop/apps/caitlyn/current/caitlyn.exe`, nil, nil, MethodScoop},
		{"dpkg", "/usr/bin/caitlyn", nil, map[string]string{"/var/lib/dpkg/info/caitlyn.list": "/.\n/usr\n/usr/bin\n/usr/bin/caitlyn\n"}, MethodDeb},
		{"rpm", "/usr/bin/caitlyn", nil, map[string]string{"/var/lib/rpm": "", "/usr/share/doc/caitlyn": ""}, MethodRPM},
		{"go install", "/home/a/go/bin/caitlyn", map[string]string{"HOME": "/home/a"}, nil, MethodGo},
		{"container", "/usr/local/bin/caitlyn", map[string]string{MethodEnv: "container"}, nil, MethodContainer},
		{"receipt", "/home/a/.local/bin/caitlyn", nil, map[string]string{"/home/a/.caitlyn/install.json": `{"method":"script","path":"/home/a/.local/bin/caitlyn","channel":"beta"}`}, MethodScript},
		{"receipt for another binary", "/opt/homebrew/Cellar/caitlyn/0.12.0/bin/caitlyn", nil, map[string]string{"/home/a/.caitlyn/install.json": `{"method":"script","path":"/home/a/.local/bin/caitlyn"}`}, MethodHomebrew},
	}
	for _, c := range cases {
		files = c.files
		if files == nil {
			files = map[string]string{}
		}
		got := probe(c.exe, c.env)
		if got.Method != c.want {
			t.Errorf("%s: got %s (%s), want %s", c.name, got.Method, got.Source, c.want)
		}
	}
	if (Install{Method: MethodHomebrew}).SelfUpdates() || !(Install{Method: MethodScript}).SelfUpdates() {
		t.Fatal("SelfUpdates")
	}
	if (Install{Method: MethodHomebrew}).ManagerCommand("") != "brew upgrade caitlyn" || (Install{Method: MethodContainer}).ManagerCommand("0.13.0") != "docker pull ghcr.io/caitlyn-ai/caitlyn:0.13.0" {
		t.Fatal("ManagerCommand")
	}
}
