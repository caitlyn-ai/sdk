package e2e

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// component reads a GitLab CI component (cli/integrations/gitlab/templates): its job's variables and script, with
// $[[ inputs.* ]] filled from inputs, then the spec's defaults.
func component(t *testing.T, name string, inputs map[string]string) (vars map[string]string, script string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot, "cli", "integrations", "gitlab", "templates", name+".yml"))
	if err != nil {
		t.Fatal(err)
	}
	docs := strings.SplitN(string(b), "\n---\n", 2)
	var spec struct {
		Spec struct {
			Inputs map[string]struct {
				Default any `yaml:"default"`
			} `yaml:"inputs"`
		} `yaml:"spec"`
	}
	if err := yaml.Unmarshal([]byte(docs[0]), &spec); err != nil {
		t.Fatal(err)
	}
	fill := regexp.MustCompile(`\$\[\[ inputs\.([a-z_]+) \]\]`)
	body := fill.ReplaceAllStringFunc(docs[1], func(m string) string {
		key := fill.FindStringSubmatch(m)[1]
		if v, ok := inputs[key]; ok {
			return v
		}
		if in, ok := spec.Spec.Inputs[key]; ok && in.Default != nil {
			if s, ok := in.Default.(string); ok {
				return s
			}
			b, _ := yaml.Marshal(in.Default)
			return strings.TrimSpace(string(b))
		}
		t.Fatalf("%s: input %s has no default and no test value", name, key)
		return ""
	})
	var jobs map[string]struct {
		Image     any               `yaml:"image"`
		Stage     string            `yaml:"stage"`
		Rules     any               `yaml:"rules"`
		Variables map[string]string `yaml:"variables"`
		Script    []string          `yaml:"script"`
	}
	if err := yaml.Unmarshal([]byte(body), &jobs); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	// Every template checks the image it runs (round 7, L7): a job in .pre, under the same rules, verifies that very
	// image with cosign, from a cosign image pinned by digest
	for jn, j := range jobs {
		if strings.HasSuffix(jn, "-verify-image") || strings.HasPrefix(jn, ".") {
			continue
		}
		image, _ := j.Image.(string)
		v, ok := jobs[jn+"-verify-image"]
		if !ok || v.Stage != ".pre" || !strings.Contains(strings.Join(v.Script, "\n"), "cosign verify --key ") ||
			!strings.Contains(strings.Join(v.Script, "\n"), "'"+image+"'") {
			t.Fatalf("%s: job %s has no .pre job verifying its image %s", name, jn, image)
		}
		if vi, _ := v.Image.(map[string]any); vi == nil || !strings.Contains(fmt.Sprint(vi["name"]), "@sha256:") {
			t.Fatalf("%s: the cosign image isn't pinned by digest: %v", name, v.Image)
		}
		if fmt.Sprint(v.Rules) != fmt.Sprint(j.Rules) {
			t.Fatalf("%s: the verify job's rules differ from %s's: %v, %v", name, jn, v.Rules, j.Rules)
		}
		return j.Variables, strings.Join(j.Script, "\n")
	}
	t.Fatalf("%s: no job", name)
	return nil, ""
}

// Every GitLab component's script runs against the mock with the CLI it ships with, so a component that passes a
// flag the CLI doesn't have, or can't satisfy one of its checks, fails here rather than in someone's pipeline.
func TestGitLabComponentsRun(t *testing.T) {
	bin := buildCLI(t)
	runComponent := func(t *testing.T, name string, inputs map[string]string) (int, string) {
		t.Helper()
		vars, script := component(t, name, inputs)
		home := t.TempDir()
		env := []string{
			"PATH=" + bin + string(os.PathListSeparator) + os.Getenv("PATH"),
			"HOME=" + home, "CAITLYN_CONFIG_DIR=" + filepath.Join(home, ".caitlyn"),
			"CAITLYN_ENDPOINT=" + base, "CAITLYN_TOKEN=pat_test", "CAITLYN_TELEMETRY=0", "CAITLYN_NO_UPDATE_NOTIFIER=1",
			"CI=true", "GITLAB_CI=true", "CI_PIPELINE_IID=7", "CI_PIPELINE_ID=1007", "CI_JOB_NAME=" + name,
			"CI_COMMIT_SHA=0123456789abcdef0123456789abcdef01234567",
		}
		for k, v := range vars {
			if k == "CAITLYN_AUTH" { // the job signs in with its ID token; here, with the mock's token
				continue
			}
			env = append(env, k+"="+v)
		}
		cmd := exec.Command("sh", "-ec", script)
		cmd.Dir = home
		cmd.Env = env
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		err := cmd.Run()
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode(), out.String()
		} else if err != nil {
			t.Fatal(err)
		}
		return 0, out.String()
	}
	ws := "your-company.caitlyn.ai"

	t.Run("diff and apply", func(t *testing.T) {
		reset(t)
		dir := filepath.Join(t.TempDir(), "caitlyn")
		if r := run(t, nil, "", "export", "--agent", agentID, "--dir", dir, "--version", "draft"); r.code != 0 {
			t.Fatalf("export: %d %s", r.code, r.errOut)
		}
		path := filepath.Join(dir, "agents", agentID+".yaml")
		b, _ := os.ReadFile(path)
		os.WriteFile(path, []byte(strings.Replace(string(b), "Answer from the HR policies.", "Answer from the HR policies. Be brief.", 1)), 0o644)
		if code, out := runComponent(t, "diff", map[string]string{"workspace": ws, "path": dir}); code != 0 {
			t.Fatalf("diff: exit %d\n%s", code, out)
		}
		if code, out := runComponent(t, "apply", map[string]string{"workspace": ws, "path": dir, "publish": "true"}); code != 0 {
			t.Fatalf("apply with publish: exit %d\n%s", code, out)
		}
		published := false
		for _, q := range sent(t, "POST") {
			if p, _ := q["path"].(string); strings.HasSuffix(p, "/publish") {
				published = true
			}
		}
		if !published {
			t.Fatal("publish: true published nothing")
		}
		// nothing left to change: apply (and publish) do nothing, and succeed
		if code, out := runComponent(t, "apply", map[string]string{"workspace": ws, "path": dir, "publish": "true"}); code != 0 {
			t.Fatalf("apply again: exit %d\n%s", code, out)
		}
	})

	t.Run("sync", func(t *testing.T) {
		reset(t)
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "leave-policy.pdf"), []byte("%PDF-1.4 leave"), 0o644)
		code, out := runComponent(t, "sync", map[string]string{"workspace": ws, "knowledge_base": kbID, "path": dir, "folder": "/handbook/", "remove_missing": "true"})
		if code != 0 {
			t.Fatalf("sync: exit %d\n%s", code, out)
		}
	})

	t.Run("run", func(t *testing.T) {
		// The run component waits for unattended runs, which the model doesn't have yet: it is checked once the CLI
		// has the command
		if out, _ := exec.Command(filepath.Join(bin, "caitlyn"), "commands", "--json").Output(); !strings.Contains(string(out), `"unattended-runs start"`) {
			t.Skip("caitlyn unattended-runs start doesn't exist yet")
		}
		reset(t)
		code, out := runComponent(t, "run", map[string]string{"workspace": ws, "agent": agentID + "@live", "prompt": "Check the leave policy.", "timeout": "30s"})
		if code == 2 {
			t.Fatalf("run: a usage error\n%s", out)
		}
	})
}

// buildCLI builds the CLI into a folder of its own, for tests that run it as a program.
func buildCLI(t *testing.T) string {
	t.Helper()
	bin := t.TempDir()
	build := exec.Command("go", "build", "-o", filepath.Join(bin, "caitlyn"), "./cmd/caitlyn")
	build.Dir = filepath.Join(repoRoot, "cli")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}
