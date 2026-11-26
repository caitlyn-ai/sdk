package ci

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var t0 = time.Date(2026, 11, 25, 14, 2, 1, 0, time.UTC)

type execCall struct {
	name  string
	args  []string
	stdin string
}

type fakeExec struct {
	calls []execCall
	err   error
}

func (f *fakeExec) run(_ context.Context, name string, args []string, stdin io.Reader) error {
	b, _ := io.ReadAll(stdin)
	f.calls = append(f.calls, execCall{name, args, string(b)})
	return f.err
}

func envOf(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func newRep(t *testing.T, provider, format string, env map[string]string, ex *fakeExec) (Reporter, *bytes.Buffer) {
	t.Helper()
	var out bytes.Buffer
	if ex == nil {
		ex = &fakeExec{}
	}
	r, err := NewReporter(Provider{Name: provider}, format, ReporterOptions{Out: &out, Lookup: envOf(env), Now: func() time.Time { return t0 }, Exec: ex.run, TempDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return r, &out
}

func phase(id, title string, detail bool) *Phase {
	return &Phase{ID: id, Title: title, Detail: detail, Start: t0, End: t0.Add(1100 * time.Millisecond)}
}

func TestNewReporterChoosesBackEnd(t *testing.T) {
	cases := []struct{ provider, format, want string }{
		{"gitlab", "", "gitlab"}, {"github", "auto", "github"}, {"buildkite", "", "buildkite"}, {"azure", "", "azure"},
		{"circleci", "", "plain"}, {"jenkins", "", "plain"}, {"generic", "", "plain"},
		{"gitlab", "plain", "plain"}, {"github", "off", "off"}, {"", "", "off"}, {"", "plain", "plain"},
	}
	for _, c := range cases {
		r, _ := newRep(t, c.provider, c.format, nil, nil)
		if r.Name() != c.want {
			t.Errorf("%s/%q: got %s, want %s", c.provider, c.format, r.Name(), c.want)
		}
	}
	if _, err := NewReporter(Provider{Name: "gitlab"}, "fancy", ReporterOptions{}); err == nil {
		t.Error("an unknown --ci-format must be refused")
	}
}

func TestGitLabSections(t *testing.T) {
	r, out := newRep(t, "gitlab", "", nil, nil)
	p := phase("plan", "Planning", true)
	r.BeginPhase(p)
	r.EndPhase(p)
	main := phase("apply hr/agent", "Importing", false)
	r.BeginPhase(main)
	r.EndPhase(main)
	unix, end := "1795615321", "1795615322"
	want := "\x1b[0Ksection_start:" + unix + ":caitlyn_plan[collapsed=true]\r\x1b[0KPlanning\n" +
		"\x1b[0Ksection_end:" + end + ":caitlyn_plan\r\x1b[0K\n" +
		"\x1b[0Ksection_start:" + unix + ":caitlyn_apply_hr_agent\r\x1b[0KImporting\n" +
		"\x1b[0Ksection_end:" + end + ":caitlyn_apply_hr_agent\r\x1b[0K\n"
	if out.String() != want {
		t.Fatalf("got %q\nwant %q", out.String(), want)
	}
}

func TestGitLabFailedPhaseLeftOpen(t *testing.T) {
	r, out := newRep(t, "gitlab", "", nil, nil)
	p := phase("upload", "Uploading", true)
	r.BeginPhase(p)
	p.Failed, p.Message = true, "3 items failed"
	r.EndPhase(p)
	s := out.String()
	if !strings.Contains(s, "\x1b[0Ksection_end:1795615322:caitlyn_upload\r\x1b[0K\n") {
		t.Fatalf("collapsed section not closed: %q", s)
	}
	open := "\x1b[0Ksection_start:1795615322:caitlyn_upload_failed\r\x1b[0KUploading failed after 1.1 s\n3 items failed\n"
	if !strings.Contains(s, open) {
		t.Fatalf("the failure must be in an open (not collapsed) section:\n%q", s)
	}
	if strings.Contains(s, "caitlyn_upload_failed[collapsed") {
		t.Fatal("the failed section is collapsed")
	}
	if err := r.Mask("s3cret"); err != ErrCannotMask {
		t.Fatalf("GitLab can't mask: got %v", err)
	}
}

func TestSectionName(t *testing.T) {
	for in, want := range map[string]string{"plan": "caitlyn_plan", "agent GHT7/hr": "caitlyn_agent_GHT7_hr", "a.b-c_d": "caitlyn_a.b-c_d", "": "caitlyn_phase"} {
		if got := SectionName(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestGitHubCommands(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "output")
	r, buf := newRep(t, "github", "", map[string]string{"GITHUB_OUTPUT": out}, nil)
	p := phase("plan", "Planning", true)
	r.BeginPhase(p)
	r.EndPhase(p)
	r.Problem(Problem{File: "caitlyn/agents/hr.yaml", Line: 12, Title: "Unknown field", Message: "models.answr is not a configuration member"})
	r.Problem(Problem{Severity: SeverityWarning, Title: "Deprecated", Message: "50% done\nnext, line"})
	f := phase("apply", "Applying", false)
	r.BeginPhase(f)
	f.Failed, f.Message = true, "conflict"
	r.EndPhase(f)
	if err := r.Mask("tok-1\ntok-2"); err != nil {
		t.Fatal(err)
	}
	want := "::group::Planning\n::endgroup::\n" +
		"::error file=caitlyn/agents/hr.yaml,line=12,title=Unknown field::models.answr is not a configuration member\n" +
		"::warning title=Deprecated::50%25 done%0Anext, line\n" +
		"::group::Applying\n::endgroup::\n::error title=Applying failed::Applying failed after 1.1 s: conflict\n" +
		"::add-mask::tok-1\n::add-mask::tok-2\n"
	if buf.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", buf.String(), want)
	}
	if err := r.Output("changes", "true"); err != nil {
		t.Fatal(err)
	}
	if err := r.Output("plan", "line one\nline two"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(out)
	lines := strings.Split(string(b), "\n")
	if lines[0] != "changes=true" {
		t.Fatalf("simple output: %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "plan<<ghadelimiter_") || lines[2] != "line one" || lines[3] != "line two" || lines[4] != strings.TrimPrefix(lines[1], "plan<<") {
		t.Fatalf("multi-line output must use the delimiter form: %q", string(b))
	}
}

func TestGitHubPropertyEscaping(t *testing.T) {
	r, buf := newRep(t, "github", "", nil, nil)
	r.Problem(Problem{File: "a,b:c.yaml", Line: 3, Column: 4, Title: "x:y", Message: "m"})
	want := "::error file=a%2Cb%3Ac.yaml,line=3,col=4,title=x%3Ay::m\n"
	if buf.String() != want {
		t.Fatalf("got %q want %q", buf.String(), want)
	}
}

func TestGitHubStepSummaryLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "summary.md")
	// Something earlier in the step already wrote most of the budget
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), StepSummaryLimit-1000), 0o644); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	r, _ := NewReporter(Provider{Name: "github"}, "", ReporterOptions{Out: &out, Lookup: envOf(map[string]string{"GITHUB_STEP_SUMMARY": path}), SummaryLink: "https://example.test/run/1"})
	md := strings.Repeat("| row | é |\n", 500)
	if err := r.Summary(md, false); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(path)
	if st.Size() > StepSummaryLimit {
		t.Fatalf("summary file is %d bytes, over the 1 MiB limit", st.Size())
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "https://example.test/run/1") || !utf8.Valid(b) {
		t.Fatal("a truncated summary must end with a note and the link, on a whole character")
	}
}

func TestGitHubSmallSummaryAppends(t *testing.T) {
	path := filepath.Join(t.TempDir(), "summary.md")
	r, _ := newRep(t, "github", "", map[string]string{"GITHUB_STEP_SUMMARY": path}, nil)
	_ = r.Summary("## one", false)
	_ = r.Summary("## two\n", false)
	b, _ := os.ReadFile(path)
	if string(b) != "## one\n## two\n" {
		t.Fatalf("got %q", b)
	}
}

func TestTruncate(t *testing.T) {
	if Truncate("short", 100, "") != "short" {
		t.Fatal("under the limit is kept")
	}
	s := strings.Repeat("ā", 1000)
	got := Truncate(s, 500, "")
	if len(got) > 500 || !utf8.ValidString(got) {
		t.Fatalf("len %d valid %v", len(got), utf8.ValidString(got))
	}
	if Truncate(s, 10, "") != "" {
		t.Fatal("when not even the note fits, nothing is written")
	}
}

func TestBuildkite(t *testing.T) {
	ex := &fakeExec{}
	r, buf := newRep(t, "buildkite", "", nil, ex)
	d := phase("hash", "Hashing", true)
	r.BeginPhase(d)
	r.EndPhase(d)
	m := phase("process", "Processing", false)
	r.BeginPhase(m)
	m.Failed, m.Message = true, "2 failed"
	r.EndPhase(m)
	want := "--- Hashing\n14:02:02 Hashing done in 1.1 s\n+++ Processing\n14:02:02 Processing failed after 1.1 s: 2 failed\n^^^ +++\n"
	if buf.String() != want {
		t.Fatalf("got %q\nwant %q", buf.String(), want)
	}
	_ = r.Summary("## Caitlyn", true)
	_ = r.Output("changes", "true")
	_ = r.Mask("s3cret")
	wantCalls := []execCall{
		{"buildkite-agent", []string{"annotate", "--context", "caitlyn", "--style", "error"}, "## Caitlyn"},
		{"buildkite-agent", []string{"meta-data", "set", "changes"}, "true"},
		{"buildkite-agent", []string{"redactor", "add"}, "s3cret"},
	}
	if len(ex.calls) != len(wantCalls) {
		t.Fatalf("calls %+v", ex.calls)
	}
	for i, c := range wantCalls {
		got := ex.calls[i]
		if got.name != c.name || strings.Join(got.args, " ") != strings.Join(c.args, " ") || got.stdin != c.stdin {
			t.Errorf("call %d: got %+v want %+v", i, got, c)
		}
		if strings.Contains(strings.Join(got.args, " "), "s3cret") {
			t.Error("a secret must go on stdin, never in arguments")
		}
	}
	ex.err = io.ErrUnexpectedEOF
	if err := r.Mask("x"); err == nil {
		t.Fatal("an agent without the redactor can't mask")
	}
}

func TestAzure(t *testing.T) {
	tmp := t.TempDir()
	r, buf := newRep(t, "azure", "", map[string]string{"AGENT_TEMPDIRECTORY": tmp}, nil)
	p := phase("plan", "Planning", true)
	r.BeginPhase(p)
	r.EndPhase(p)
	r.Problem(Problem{File: "caitlyn/agents/hr.yaml", Line: 12, Column: 3, Title: "Unknown field", Message: "a;b]c"})
	r.Problem(Problem{Severity: SeverityNotice, Message: "fyi"})
	_ = r.Output("plan", "a\nb")
	_ = r.Mask("s3cret")
	if err := r.Summary("## Caitlyn", false); err != nil {
		t.Fatal(err)
	}
	s := buf.String()
	for _, want := range []string{
		"##[group]Planning\n##[endgroup]\n",
		"##vso[task.logissue type=error;sourcepath=caitlyn/agents/hr.yaml;linenumber=12;columnnumber=3]Unknown field: a;b]c\n",
		"##vso[task.logissue type=warning]fyi\n",
		"##vso[task.setvariable variable=plan;isOutput=true]a%0Ab\n",
		"##vso[task.setsecret]s3cret\n",
		"##vso[task.uploadsummary]" + tmp,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in\n%s", want, s)
		}
	}
	matches, _ := filepath.Glob(filepath.Join(tmp, "caitlyn-summary-*.md"))
	if len(matches) != 1 {
		t.Fatal("the summary file must be written for task.uploadsummary")
	}
}

func TestPlainAndOff(t *testing.T) {
	r, buf := newRep(t, "circleci", "", nil, nil)
	p := phase("plan", "Planning", true)
	r.BeginPhase(p)
	r.EndPhase(p)
	r.Problem(Problem{File: "a.yaml", Line: 2, Message: "bad"})
	r.Line("Uploaded 3 of 10")
	want := "14:02:01 Planning\n14:02:02 Planning done in 1.1 s\na.yaml:2: error: bad\n14:02:01 Uploaded 3 of 10\n"
	if buf.String() != want {
		t.Fatalf("got %q\nwant %q", buf.String(), want)
	}
	for _, s := range []string{"\x1b", "::", "##", "---"} {
		if strings.Contains(buf.String(), s) {
			t.Errorf("plain output has a marker %q", s)
		}
	}
	o, obuf := newRep(t, "github", "off", nil, nil)
	o.BeginPhase(p)
	o.EndPhase(p)
	o.Problem(Problem{Message: "x"})
	o.Line("y")
	if obuf.Len() != 0 {
		t.Fatalf("off prints nothing: %q", obuf.String())
	}
}
