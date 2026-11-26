package update

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The installers check the release manifest's minisign signature with whatever the machine has: minisign, else
// OpenSSL 3, else Node.js. Each must verify exactly what minisign makes (scripts/testdata/minisign, made with a real
// minisign: the default "ED" algorithm, Ed25519 over the file's BLAKE2b-512 hash, and the global signature over the
// trusted comment) and the legacy "Ed" form, and refuse a changed file, a changed trusted comment and another key.

func fixturePub(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "scripts", "testdata", "minisign", name+".pub"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(strings.Split(strings.TrimSpace(string(b)), "\n")[1])
}

// toolsDir is a PATH holding only the shell tools install.sh uses, and the verifier named.
func toolsDir(t *testing.T, verifier string) string {
	t.Helper()
	dir := t.TempDir()
	tools := []string{"sh", "sed", "head", "tail", "cmp", "wc", "tr", "mktemp", "rm", "cat", "cp", "grep", "printf"}
	if verifier != "" {
		tools = append(tools, verifier)
	}
	for _, tool := range tools {
		p, err := exec.LookPath(tool)
		if err != nil {
			if tool == verifier {
				t.Skipf("%s isn't on this machine", tool)
			}
			continue
		}
		if err := os.Symlink(p, filepath.Join(dir, tool)); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestInstallShVerifiesMinisign(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("install.sh is for macOS and Linux")
	}
	script, _ := filepath.Abs(filepath.Join("..", "..", "scripts", "install.sh"))
	data, _ := filepath.Abs(filepath.Join("..", "..", "scripts", "testdata", "minisign"))
	release, legacy, other := fixturePub(t, "release"), fixturePub(t, "legacy"), fixturePub(t, "other")
	cases := []struct {
		name, pub, file string
		want            int
	}{
		{"minisign's own signature (ED, prehashed)", release, "manifest.json", 0},
		{"a legacy signature (Ed)", legacy, "legacy.json", 0},
		{"a changed manifest", release, "tampered.json", 1},
		{"a changed trusted comment", release, "comment.json", 1},
		{"another key", other, "manifest.json", 1},
	}
	for _, verifier := range []string{"minisign", "openssl", "node"} {
		t.Run(verifier, func(t *testing.T) {
			path := toolsDir(t, verifier)
			if verifier == "openssl" {
				// OpenSSL 1.1 and LibreSSL can't verify Ed25519 from the command line: the script moves on, so here
				// that is a skip, not a pass
				if out, _ := exec.Command("openssl", "pkeyutl", "-help").CombinedOutput(); !strings.Contains(string(out), "-rawin") {
					t.Skip("this openssl has no pkeyutl -rawin")
				}
			}
			for _, c := range cases {
				cmd := exec.Command("sh", script, "--verify-signature", c.pub, filepath.Join(data, c.file), filepath.Join(data, c.file+".minisig"))
				cmd.Env = []string{"PATH=" + path, "HOME=" + t.TempDir()}
				out, err := cmd.CombinedOutput()
				code := 0
				if ee, ok := err.(*exec.ExitError); ok {
					code = ee.ExitCode()
				} else if err != nil {
					t.Fatal(err)
				}
				if code != c.want {
					t.Errorf("%s: exit %d, want %d: %s", c.name, code, c.want, out)
				}
			}
		})
	}
	t.Run("nothing to check it with", func(t *testing.T) {
		cmd := exec.Command("sh", script, "--verify-signature", release, filepath.Join(data, "manifest.json"), filepath.Join(data, "manifest.json.minisig"))
		cmd.Env = []string{"PATH=" + toolsDir(t, ""), "HOME=" + t.TempDir()}
		out, err := cmd.CombinedOutput()
		if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 2 || !strings.Contains(string(out), "not verified (2)") {
			t.Fatalf("exit 2 when no verifier is here: %v %s", err, out)
		}
	})
}

// A Node too old for Ed25519 (before Node 12: no crypto.createPublicKey) can't check the signature: exit 2, "can't
// verify", never 1, which would call a good release forged (round 7, L3).
func TestInstallShOldNodeCantVerify(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("install.sh is for macOS and Linux")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node isn't on this machine")
	}
	script, _ := filepath.Abs(filepath.Join("..", "..", "scripts", "install.sh"))
	data, _ := filepath.Abs(filepath.Join("..", "..", "scripts", "testdata", "minisign"))
	path := toolsDir(t, "")
	old := filepath.Join(t.TempDir(), "old-node.js")
	os.WriteFile(old, []byte("delete require('crypto').createPublicKey;\n"), 0o644)
	os.WriteFile(filepath.Join(path, "node"), []byte("#!/bin/sh\nexec "+node+" -r "+old+" \"$@\"\n"), 0o755)
	cmd := exec.Command("sh", script, "--verify-signature", fixturePub(t, "release"), filepath.Join(data, "manifest.json"), filepath.Join(data, "manifest.json.minisig"))
	cmd.Env = []string{"PATH=" + path, "HOME=" + t.TempDir()}
	out, err := cmd.CombinedOutput()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 2 || !strings.Contains(string(out), "not verified (2)") {
		t.Fatalf("an old Node is exit 2, can't verify: %v %s", err, out)
	}
}

// install.sh installs only the release it was pointed at: the pointer's manifest path is the version's own, and the
// manifest it reads names that version and its channel (round 7, L2).
func TestInstallShChecksThePointerAgainstTheManifest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("install.sh is for macOS and Linux")
	}
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl isn't on this machine")
	}
	script, _ := filepath.Abs(filepath.Join("..", "..", "scripts", "install.sh"))
	goos, goarch := runtime.GOOS, runtime.GOARCH
	// a release whose binary is a script that prints its version
	tgz := func(t *testing.T) []byte {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "caitlyn"), []byte("#!/bin/sh\necho '{\"version\": \"1.2.3\"}'\n"), 0o755)
		out, err := exec.Command("tar", "-czf", "-", "-C", dir, "caitlyn").Output()
		if err != nil {
			t.Fatal(err)
		}
		return out
	}(t)
	sum := sha256.Sum256(tgz)
	manifestFor := func(version, channel string) string {
		return fmt.Sprintf("{\n  \"version\": \"%s\",\n  \"channel\": \"%s\",\n  \"date\": \"2026-11-25\",\n  \"platforms\": [\n    {\"os\": \"%s\", \"arch\": \"%s\", \"url\": \"caitlyn.tar.gz\", \"size\": %d, \"sha256\": \"%s\"}\n  ]\n}\n",
			version, channel, goos, goarch, len(tgz), hex.EncodeToString(sum[:]))
	}
	cases := []struct {
		name, pointer, manifest, want string
	}{
		{"the release pointed at", `{"version": "1.2.3", "manifest": "1.2.3/manifest.json"}`, manifestFor("1.2.3", "stable"), "Installed caitlyn 1.2.3"},
		{"a manifest path elsewhere", `{"version": "1.2.3", "manifest": "../other/manifest.json"}`, manifestFor("1.2.3", "stable"), "not 1.2.3's manifest"},
		{"another version's manifest", `{"version": "1.2.3", "manifest": "1.2.3/manifest.json"}`, manifestFor("1.0.0", "stable"), "the manifest is for 1.0.0, not 1.2.3"},
		{"a beta manifest for a stable release", `{"version": "1.2.3", "manifest": "1.2.3/manifest.json"}`, manifestFor("1.2.3", "beta"), "the manifest is for the beta channel"},
		{"a prerelease on stable", `{"version": "1.2.3-beta.1", "manifest": "1.2.3-beta.1/manifest.json"}`, manifestFor("1.2.3-beta.1", "beta"), "a prerelease"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/channels/stable.json":
					io.WriteString(w, c.pointer)
				case strings.HasSuffix(r.URL.Path, "/manifest.json"):
					io.WriteString(w, c.manifest)
				case strings.HasSuffix(r.URL.Path, "/caitlyn.tar.gz"):
					w.Write(tgz)
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			home := t.TempDir()
			cmd := exec.Command("sh", script)
			cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "CAITLYN_BASE_URL=" + srv.URL + "/", "CAITLYN_INSTALL_DIR=" + filepath.Join(home, "bin")}
			out, _ := cmd.CombinedOutput()
			if !strings.Contains(string(out), c.want) {
				t.Fatalf("want %q:\n%s", c.want, out)
			}
			if _, err := os.Stat(filepath.Join(home, "bin", "caitlyn")); (err == nil) != strings.HasPrefix(c.want, "Installed") {
				t.Fatalf("installed: %v, want %v", err == nil, strings.HasPrefix(c.want, "Installed"))
			}
		})
	}
}
