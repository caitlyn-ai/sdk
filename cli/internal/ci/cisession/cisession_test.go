package cisession_test

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/ci/cisession"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
)

// probe is a command that reports like kb sync: a detail phase, a main phase, checks, an output, a link, and a
// question it can only ask a person.
func probe(root *cobra.Command, f *cmdutil.Factory) {
	var ask, secret bool
	c := &cobra.Command{
		Use: "probe", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			run := cisession.For(f)
			if err := run.AcceptFailOn(ci.SyncConditions, ci.SyncDefaults); err != nil {
				return err
			}
			run.Phase("hash", "Hashing 3 files", ci.Detail()).Done()
			ph := run.Phase("upload", "Uploading")
			run.Progress("Uploaded 1 of 3")
			run.Case(ci.TestCase{Name: "a.pdf", Status: ci.Passed})
			run.Case(ci.TestCase{Name: "b.pdf", Status: ci.Skipped, Message: "unchanged"})
			run.Hold("skipped")
			ph.Done()
			run.Problem(ci.Problem{File: "caitlyn/kb.yaml", Line: 4, Title: "Unknown field", Message: "foldr is not a member"})
			_ = run.Output("changes", "true")
			run.Link("Batch", "https://ws.example/batches/B1")
			if secret {
				if err := run.Secret("sig-secret"); err != nil {
					return err
				}
				cmd.OutOrStdout().Write([]byte("sig-secret\n"))
			}
			if ask {
				if _, err := prompt.For(f.IO); err != nil {
					return cmdutil.ActionNeeded("Remove 2 items?", "--yes")
				}
			}
			return run.Finish(0)
		},
	}
	c.Flags().BoolVar(&ask, "ask", false, "")
	c.Flags().BoolVar(&secret, "secret", false, "")
	root.AddCommand(c)
}

type result struct {
	code           int
	stdout, stderr string
	f              *cmdutil.Factory
}

func runCLI(t *testing.T, env map[string]string, tty bool, args ...string) result {
	t.Helper()
	saveAdd, saveBefore, saveAfter := root.AddCommands, root.BeforeRun, root.AfterRun
	t.Cleanup(func() { root.AddCommands, root.BeforeRun, root.AfterRun = saveAdd, saveBefore, saveAfter })
	root.AddCommands = []func(*cobra.Command, *cmdutil.Factory){cisession.Register, probe}
	root.BeforeRun = []func(*cmdutil.Factory, *cobra.Command){cisession.BeforeRun}
	root.AfterRun = []func(*cmdutil.Factory, *cobra.Command, int, time.Duration){
		func(f *cmdutil.Factory, cmd *cobra.Command, code int, took time.Duration) {
			cisession.AfterRun(f, code)
		},
	}
	io, out, errOut := iostreams.Test("")
	if tty {
		io.SetTTY(true, true, true)
	}
	home := t.TempDir()
	io.Environ = []string{"CAITLYN_CONFIG_DIR=" + filepath.Join(home, ".caitlyn")}
	for k, v := range env {
		io.Setenv(k, v)
	}
	var fac *cmdutil.Factory
	code := root.Run(context.Background(), io, args, func(f *cmdutil.Factory) {
		f.Home, f.WorkDir = home, home
		f.Now = func() time.Time { return time.Date(2026, 11, 25, 14, 2, 1, 0, time.UTC) }
		fac = f
	})
	return result{code, out.String(), errOut.String(), fac}
}

type fakeAgent struct{ calls []string }

func (a *fakeAgent) run(_ context.Context, name string, args []string, stdin io.Reader) error {
	b, _ := io.ReadAll(stdin)
	a.calls = append(a.calls, name+" "+strings.Join(args, " ")+" <<"+string(b))
	return nil
}

// TestCIModePerProvider runs the probe with each provider's variables, as 17.2's CI-mode row asks: the markers,
// annotations, summary and output files, masking, no prompts, no decoration, and exit 3 where a prompt would be.
func TestCIModePerProvider(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		env     map[string]string
		markers []string
		absent  []string
	}{
		{"gitlab", map[string]string{"GITLAB_CI": "true", "CI_MERGE_REQUEST_IID": "7"},
			[]string{"section_start:1795615321:caitlyn_hash[collapsed=true]\r\x1b[0KHashing 3 files", "section_start:1795615321:caitlyn_upload\r\x1b[0KUploading", "section_end:1795615321:caitlyn_upload", "14:02:01 Uploaded 1 of 3", "caitlyn/kb.yaml:4: error: Unknown field: foldr is not a member"},
			[]string{"::group::", "##[group]"}},
		{"github", map[string]string{"GITHUB_ACTIONS": "true", "GITHUB_STEP_SUMMARY": filepath.Join(dir, "gh-summary.md"), "GITHUB_OUTPUT": filepath.Join(dir, "gh-output")},
			[]string{"::group::Hashing 3 files\n::endgroup::", "::group::Uploading", "::error file=caitlyn/kb.yaml,line=4,title=Unknown field::foldr is not a member"},
			[]string{"section_start"}},
		{"buildkite", map[string]string{"BUILDKITE": "true"},
			[]string{"--- Hashing 3 files", "+++ Uploading"}, []string{"::group::"}},
		{"azure", map[string]string{"TF_BUILD": "True", "AGENT_TEMPDIRECTORY": dir},
			[]string{"##[group]Hashing 3 files", "##vso[task.logissue type=error;sourcepath=caitlyn/kb.yaml;linenumber=4]", "##vso[task.setvariable variable=changes;isOutput=true]true", "##vso[task.uploadsummary]"},
			[]string{"::group::"}},
		{"circleci", map[string]string{"CIRCLECI": "true"},
			[]string{"14:02:01 Hashing 3 files", "14:02:01 Hashing 3 files done in 0.0 s"}, []string{"::group::", "section_start", "##["}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			agent := &fakeAgent{}
			cisession.SetExec(agent.run)
			t.Cleanup(func() { cisession.SetExec(nil) })
			wd := t.TempDir()
			r := runCLI(t, c.env, true, "probe", "--report", "junit="+filepath.Join(wd, "r.xml"), "--summary-file", filepath.Join(wd, "s.md"), "--outputs-file", filepath.Join(wd, "o.env"))
			if r.code != 0 {
				t.Fatalf("exit %d: %s", r.code, r.stderr)
			}
			for _, m := range c.markers {
				if !strings.Contains(r.stderr, m) {
					t.Errorf("missing %q in\n%q", m, r.stderr)
				}
			}
			for _, m := range c.absent {
				if strings.Contains(r.stderr, m) {
					t.Errorf("unexpected %q", m)
				}
			}
			if r.stdout != "" {
				t.Errorf("CI markers must never go to stdout: %q", r.stdout)
			}
			if !r.f.IO.NeverPrompt || r.f.IO.Decorate {
				t.Error("CI never prompts and never decorates (no spinners)")
			}
			for _, f := range []string{"r.xml", "s.md", "o.env"} {
				if _, err := os.Stat(filepath.Join(wd, f)); err != nil {
					t.Errorf("%s not written: %v", f, err)
				}
			}
			env, _ := os.ReadFile(filepath.Join(wd, "o.env"))
			if string(env) != "changes=true\n" {
				t.Errorf("outputs file: %q", env)
			}
			switch c.name {
			case "github":
				sum, _ := os.ReadFile(c.env["GITHUB_STEP_SUMMARY"])
				if !strings.Contains(string(sum), "## Caitlyn: probe") {
					t.Errorf("step summary: %q", sum)
				}
				out, _ := os.ReadFile(c.env["GITHUB_OUTPUT"])
				if string(out) != "changes=true\n" {
					t.Errorf("GITHUB_OUTPUT: %q", out)
				}
			case "buildkite":
				joined := strings.Join(agent.calls, "\n")
				if !strings.Contains(joined, "buildkite-agent meta-data set changes <<true") || !strings.Contains(joined, "buildkite-agent annotate --context caitlyn --style success <<## Caitlyn: probe") {
					t.Errorf("buildkite-agent calls: %s", joined)
				}
			}

			// A prompt in CI exits 3, even on a terminal
			r = runCLI(t, c.env, true, "probe", "--ask")
			if r.code != 3 {
				t.Errorf("a question in CI exits 3, got %d", r.code)
			}
		})
	}
}

func TestSecretsInCI(t *testing.T) {
	gh := map[string]string{"GITHUB_ACTIONS": "true"}
	r := runCLI(t, gh, false, "probe", "--secret")
	if r.code != 2 || strings.Contains(r.stdout, "sig-secret") || !strings.Contains(r.stderr, "SECRET_IN_CI") {
		t.Fatalf("refused without --show-secret: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = runCLI(t, gh, false, "probe", "--secret", "--show-secret")
	if r.code != 0 || !strings.Contains(r.stderr, "::add-mask::sig-secret") {
		t.Fatalf("GitHub masks first: %d %q", r.code, r.stderr)
	}
	r = runCLI(t, map[string]string{"GITLAB_CI": "true"}, false, "probe", "--secret", "--show-secret")
	if r.code != 5 || strings.Contains(r.stdout, "sig-secret") || !strings.Contains(r.stderr, "SECRET_UNMASKABLE") {
		t.Fatalf("GitLab refuses: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = runCLI(t, nil, false, "probe", "--secret")
	if r.code != 0 || !strings.Contains(r.stdout, "sig-secret") {
		t.Fatalf("outside CI it prints: %d", r.code)
	}
}

func TestFlagsAreChecked(t *testing.T) {
	for _, args := range [][]string{
		{"probe", "--report", "html=x.html"},
		{"probe", "--fail-on", "fialed"},
		{"probe", "--fail-on", "never,failed"},
		{"probe", "--ci-format", "fancy"},
	} {
		if r := runCLI(t, nil, false, args...); r.code != 2 {
			t.Errorf("%v: exit %d, want 2 (%s)", args, r.code, r.stderr)
		}
	}
	if r := runCLI(t, nil, false, "probe", "--fail-on", "changes"); r.code != 2 || !strings.Contains(r.stderr, "FAIL_ON_NOT_APPLICABLE") {
		t.Errorf("a condition the command doesn't take is a usage error: %d %s", r.code, r.stderr)
	}
	if r := runCLI(t, nil, false, "probe", "--fail-on", "skipped"); r.code != 1 || !strings.Contains(r.stderr, "FAIL_ON") {
		t.Errorf("--fail-on skipped with a skipped item exits 1: %d %s", r.code, r.stderr)
	}
}

func TestCIFormatPlainAndOff(t *testing.T) {
	gl := map[string]string{"GITLAB_CI": "true"}
	r := runCLI(t, gl, false, "probe", "--ci-format", "plain")
	if strings.Contains(r.stderr, "section_start") || !strings.Contains(r.stderr, "14:02:01 Uploading") {
		t.Fatalf("plain: %q", r.stderr)
	}
	r = runCLI(t, gl, false, "probe", "--ci-format", "off")
	if strings.Contains(r.stderr, "section_start") || strings.Contains(r.stderr, "Uploading") {
		t.Fatalf("off: %q", r.stderr)
	}
}

// TestFilesWrittenWhenTheCommandFails: a command that fails before reporting still leaves its report, as a job
// killed by the runner can't.
func TestFilesWrittenWhenTheCommandFails(t *testing.T) {
	wd := t.TempDir()
	r := runCLI(t, map[string]string{"GITLAB_CI": "true"}, false, "probe", "--ask", "--report", "junit="+filepath.Join(wd, "r.xml"), "--summary-file", filepath.Join(wd, "s.md"))
	if r.code != 3 {
		t.Fatalf("exit %d", r.code)
	}
	md, err := os.ReadFile(filepath.Join(wd, "s.md"))
	if err != nil || !bytes.Contains(md, []byte("exit code 3")) {
		t.Fatalf("summary after a failure: %v %q", err, md)
	}
	if _, err := os.Stat(filepath.Join(wd, "r.xml")); err != nil {
		t.Fatal(err)
	}
}
