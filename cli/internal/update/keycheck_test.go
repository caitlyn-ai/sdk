package update

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// cli:release runs scripts/minisign-key-check.sh first, so a release is never built with the placeholder minisign
// key (which refuses every `caitlyn update`) or a malformed one: it passes a real minisign public key and stops on
// everything else, before anything is built or signed.
func TestMinisignKeyCheck(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the release jobs run on Linux")
	}
	script, _ := filepath.Abs(filepath.Join("..", "..", "scripts", "minisign-key-check.sh"))
	good := fixturePub(t, "release")
	for _, c := range []struct {
		name, key, want string
		ok              bool
	}{
		{"a real key", good, "is a minisign public key", true},
		// cli:publish compares the value exactly, so whitespace stops the release here rather than after the build
		{"a trailing newline", good + "\n", "space, tab or line break", false},
		{"a trailing CRLF", good + "\r\n", "space, tab or line break", false},
		{"a trailing space", good + " ", "space, tab or line break", false},
		{"a leading space", " " + good, "space, tab or line break", false},
		{"a space from a wrapped paste", good[:20] + " " + good[20:], "space, tab or line break", false},
		{"a tab", good + "\t", "space, tab or line break", false},
		{"a whole minisign.pub", "untrusted comment: minisign public key E015DE3B2920E1BB\n" + good + "\n", "comment line", false},
		{"a File variable's path", "/builds/custom-d/caitlyn/sdk.tmp/CAITLYN_MINISIGN_PUBLIC_KEY", "file path", false},
		{"unset", "", "isn't set", false},
		{"the build's placeholder", "REPLACE_AT_RELEASE_minisign_public_key", "still the placeholder", false},
		{"the installer's placeholder", "__MINISIGN_PUBLIC_KEY__", "still the placeholder", false},
		{"minisign.pub's comment line", "untrusted comment: minisign public key E015DE3B2920E1BB", "comment line", false},
		{"cut short", good[:40], "not the 56", false},
		{"not base64", strings.Replace(good, "R", "!", 1), "isn't base64", false},
		{"not Ed25519", "Q" + good[1:], "isn't an Ed25519", false},
		{"RW but not Ed", "RWA" + good[3:], "isn't an Ed25519", false},
	} {
		cmd := exec.Command("sh", script)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "CAITLYN_MINISIGN_PUBLIC_KEY=" + c.key}
		out, err := cmd.CombinedOutput()
		if (err == nil) != c.ok || !strings.Contains(string(out), c.want) {
			t.Errorf("%s: ok=%v, want %v: %s", c.name, err == nil, c.ok, out)
		}
	}
}

// The check holds its place: it is cli:release's first command, before the build and the signature.
func TestMinisignKeyCheckRunsFirstInRelease(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", ".gitlab-ci.yml"))
	if err != nil {
		t.Fatal(err)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	var script []string
	root := doc.Content[0]
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value != "cli:release" {
			continue
		}
		job := root.Content[i+1]
		for j := 0; j+1 < len(job.Content); j += 2 {
			if job.Content[j].Value == "script" {
				for _, n := range job.Content[j+1].Content {
					script = append(script, n.Value)
				}
			}
		}
	}
	if len(script) == 0 || script[0] != "cli/scripts/minisign-key-check.sh" {
		t.Fatalf("cli:release's first command is %q, want cli/scripts/minisign-key-check.sh", script)
	}
	for i, line := range script {
		if strings.Contains(line, "goreleaser") || strings.Contains(line, "cosign") {
			if i == 0 {
				t.Fatalf("%q comes before the key check", line)
			}
		}
	}
}
