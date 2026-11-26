package ci

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseFailOn(t *testing.T) {
	got, err := ParseFailOn([]string{"failed,non_compliant", "FAILED", " changes "})
	if err != nil || strings.Join(got, ",") != "failed,non_compliant,changes" {
		t.Fatalf("got %v %v", got, err)
	}
	for _, bad := range [][]string{{"fialed"}, {"never,failed"}, {"never", "changes"}} {
		if _, err := ParseFailOn(bad); err == nil {
			t.Errorf("%v must be refused", bad)
		}
	}
	if got, err := ParseFailOn([]string{"never"}); err != nil || len(got) != 1 {
		t.Fatalf("never alone: %v %v", got, err)
	}
}

func TestParseReport(t *testing.T) {
	r, err := ParseReport("junit=build/plan.xml")
	if err != nil || r.Format != "junit" || r.Path != "build/plan.xml" {
		t.Fatalf("%+v %v", r, err)
	}
	for _, bad := range []string{"junit", "junit=", "html=x.html", "json=-", "=x"} {
		if _, err := ParseReport(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}

func newSession(t *testing.T, o Options) (*Session, *bytes.Buffer) {
	t.Helper()
	var out bytes.Buffer
	o.Out = &out
	if o.Now == nil {
		o.Now = func() time.Time { return t0 }
	}
	if o.WorkDir == "" {
		o.WorkDir = t.TempDir()
	}
	s, err := NewSession(o)
	if err != nil {
		t.Fatal(err)
	}
	return s, &out
}

func TestFailOnExitCodes(t *testing.T) {
	cases := []struct {
		name     string
		given    []string
		allowed  []string
		defaults []string
		held     []string
		code     int
		want     int
	}{
		{"default failed holds", nil, SyncConditions, SyncDefaults, []string{"failed"}, 0, 1},
		{"default ignores skipped", nil, SyncConditions, SyncDefaults, []string{"skipped"}, 0, 0},
		{"given skipped", []string{"skipped"}, SyncConditions, SyncDefaults, []string{"skipped"}, 0, 1},
		{"unresolved needs action", []string{"unresolved"}, SyncConditions, SyncDefaults, []string{"unresolved"}, 0, 3},
		{"failure beats action", []string{"unresolved", "failed"}, SyncConditions, SyncDefaults, []string{"unresolved", "failed"}, 0, 1},
		{"never turns all off", []string{"never"}, SyncConditions, SyncDefaults, []string{"failed"}, 0, 0},
		{"diff default is never", nil, DiffConditions, DiffDefaults, []string{"changes"}, 0, 0},
		{"diff changes", []string{"changes"}, DiffConditions, DiffDefaults, []string{"changes"}, 0, 3},
		{"deprecated on any command", []string{"deprecated"}, nil, nil, []string{"deprecated"}, 0, 3},
		{"skew on any command", []string{"skew"}, nil, nil, []string{"skew"}, 0, 3},
		{"the command's own failure wins", []string{"changes"}, DiffConditions, DiffDefaults, []string{"changes"}, 7, 7},
		{"non_compliant", []string{"failed", "non_compliant"}, RunConditions, RunDefaults, []string{"non_compliant"}, 0, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _ := newSession(t, Options{FailOn: c.given})
			if c.allowed != nil {
				if err := s.AcceptFailOn(c.allowed, c.defaults); err != nil {
					t.Fatal(err)
				}
			}
			for _, h := range c.held {
				s.Hold(h)
			}
			if got := s.Finish(c.code).Exit; got != c.want {
				t.Fatalf("exit %d, want %d", got, c.want)
			}
		})
	}
}

func TestAcceptFailOnRefusesOtherCommandsConditions(t *testing.T) {
	s, _ := newSession(t, Options{FailOn: []string{"changes"}})
	if err := s.AcceptFailOn(SyncConditions, SyncDefaults); err == nil {
		t.Fatal("--fail-on changes doesn't apply to kb sync")
	}
	s2, _ := newSession(t, Options{FailOn: []string{"changes"}})
	if ign := s2.Ignored(); len(ign) != 1 || ign[0] != "changes" {
		t.Fatalf("a command that never declares conditions ignores them: %v", ign)
	}
	if s2.Finish(0).Exit != 0 {
		t.Fatal("an ignored condition never fails a run")
	}
}

func TestSecret(t *testing.T) {
	// Outside CI: allowed, with or without the flag
	s, out := newSession(t, Options{})
	if err := s.Secret("tok"); err != nil || out.Len() != 0 {
		t.Fatalf("outside CI: %v %q", err, out.String())
	}
	for _, p := range []string{"gitlab", "github", "buildkite", "azure", "circleci", "generic"} {
		s, _ := newSession(t, Options{Provider: Provider{Name: p}, Exec: (&fakeExec{}).run})
		var se *SecretError
		if err := s.Secret("tok"); !errors.As(err, &se) || !se.NeedsFlag {
			t.Errorf("%s without --show-secret: %v", p, err)
		}
	}
	// With --show-secret: masked first on GitHub, refused on GitLab, even with --ci-format off
	gh, out := newSession(t, Options{Provider: Provider{Name: "github"}, ShowSecret: true, Format: "off"})
	if err := gh.Secret("tok-123"); err != nil {
		t.Fatal(err)
	}
	if out.String() != "::add-mask::tok-123\n" {
		t.Fatalf("GitHub must mask first, whatever --ci-format says: %q", out.String())
	}
	gl, _ := newSession(t, Options{Provider: Provider{Name: "gitlab"}, ShowSecret: true})
	var se *SecretError
	if err := gl.Secret("tok"); !errors.As(err, &se) || se.NeedsFlag || !errors.Is(err, ErrCannotMask) {
		t.Fatalf("GitLab must refuse: %v", err)
	}
	gen, out := newSession(t, Options{Provider: Provider{Name: "generic"}, ShowSecret: true})
	if err := gen.Secret("tok"); err != nil || out.Len() != 0 {
		t.Fatalf("generic CI with --show-secret prints it: %v", err)
	}
}

func TestProgressAtMostEvery10s(t *testing.T) {
	now := t0
	s, out := newSession(t, Options{Provider: Provider{Name: "gitlab"}, Now: func() time.Time { return now }})
	s.Progress("1 of 10")
	now = now.Add(4 * time.Second)
	s.Progress("2 of 10")
	now = now.Add(6 * time.Second)
	s.Progress("3 of 10")
	if out.String() != "14:02:01 1 of 10\n14:02:11 3 of 10\n" {
		t.Fatalf("got %q", out.String())
	}
}

func TestFinishWritesEveryFile(t *testing.T) {
	dir := t.TempDir()
	s, _ := newSession(t, Options{
		Provider: Provider{Name: "gitlab"}, WorkDir: dir, Title: "kb sync", Version: "0.12.0",
		Reports:     []string{"junit=out/sync.xml", "markdown=sync.md", "json=sync.json", "annotations=links.json"},
		SummaryFile: "summary.md", OutputsFile: "caitlyn.env",
	})
	if err := s.AcceptFailOn(SyncConditions, SyncDefaults); err != nil {
		t.Fatal(err)
	}
	ph := s.Phase("upload", "Uploading", Detail())
	ph.Done()
	s.Case(TestCase{Name: "handbook.pdf", Status: Passed, Duration: 1500 * time.Millisecond})
	s.Case(TestCase{Name: "policy & <rules>.docx", Status: Failed, Message: "CHECKSUM_MISMATCH", Detail: "uploaded twice"})
	s.Case(TestCase{Name: "old.txt", Status: Skipped, Message: "unchanged"})
	s.Hold("failed")
	if err := s.Output("batch_id", "B123"); err != nil {
		t.Fatal(err)
	}
	_ = s.Output("plan", "line 1\nline 2")
	_ = s.Output("batch_id", "B124")
	if err := s.Output("1bad", "x"); err == nil {
		t.Fatal("an output name must be a variable name")
	}
	s.Link("Batch B124", "https://your-company.caitlyn.ai/kb/batches/B124")
	s.Summary("Sync", "1 added, 1 failed")
	res := s.Finish(0)
	if res.Exit != 1 || len(res.Errors) != 0 {
		t.Fatalf("%+v", res)
	}

	b, err := os.ReadFile(filepath.Join(dir, "out/sync.xml"))
	if err != nil {
		t.Fatal(err)
	}
	type tc struct {
		Name    string `xml:"name,attr"`
		Failure *struct {
			Message string `xml:"message,attr"`
		} `xml:"failure"`
		Skipped *struct{} `xml:"skipped"`
	}
	var doc struct {
		XMLName  xml.Name `xml:"testsuites"`
		Tests    int      `xml:"tests,attr"`
		Failures int      `xml:"failures,attr"`
		Skipped  int      `xml:"skipped,attr"`
		Suites   []struct {
			Name  string `xml:"name,attr"`
			Cases []tc   `xml:"testcase"`
		} `xml:"testsuite"`
	}
	if err := xml.Unmarshal(b, &doc); err != nil {
		t.Fatalf("JUnit isn't valid XML: %v\n%s", err, b)
	}
	if doc.Tests != 3 || doc.Failures != 1 || doc.Skipped != 1 || len(doc.Suites) != 1 || doc.Suites[0].Name != "kb sync" {
		t.Fatalf("JUnit counts: %+v", doc)
	}
	if c := doc.Suites[0].Cases[1]; c.Name != "policy & <rules>.docx" || c.Failure == nil || c.Failure.Message != "CHECKSUM_MISMATCH" {
		t.Fatalf("failed case: %+v", c)
	}

	md, _ := os.ReadFile(filepath.Join(dir, "sync.md"))
	summary, _ := os.ReadFile(filepath.Join(dir, "summary.md"))
	if !bytes.Equal(md, summary) {
		t.Fatal("--report markdown and --summary-file are the same summary")
	}
	for _, want := range []string{"## Caitlyn: kb sync", "**Failed** (exit code 1, --fail-on failed)", "### Sync", "1 passed, 1 failed, 1 skipped", "| policy & <rules>.docx | failed | CHECKSUM_MISMATCH |", "[Batch B124](https://your-company.caitlyn.ai/kb/batches/B124)", "Caitlyn CLI 0.12.0"} {
		if !strings.Contains(string(md), want) {
			t.Errorf("summary is missing %q:\n%s", want, md)
		}
	}
	// Failures are listed first
	if strings.Index(string(md), "policy") > strings.Index(string(md), "handbook") {
		t.Error("failed checks come first in the summary")
	}

	env, _ := os.ReadFile(filepath.Join(dir, "caitlyn.env"))
	if string(env) != "batch_id=B124\nplan=line 1\\nline 2\n" {
		t.Fatalf("dotenv: %q", env)
	}

	var j Document
	jb, _ := os.ReadFile(filepath.Join(dir, "sync.json"))
	if err := json.Unmarshal(jb, &j); err != nil || j.ExitCode != 1 || len(j.Cases) != 3 || j.Title != "kb sync" {
		t.Fatalf("json: %v %+v", err, j)
	}
	ab, _ := os.ReadFile(filepath.Join(dir, "links.json"))
	if !strings.Contains(string(ab), `"external_link"`) || !strings.Contains(string(ab), "B124") {
		t.Fatalf("annotations: %s", ab)
	}

	// Finish runs once
	if again := s.Finish(0); again.Exit != 1 {
		t.Fatal("a second Finish returns the first result")
	}
}

func TestJSONReportIsTheResult(t *testing.T) {
	dir := t.TempDir()
	s, _ := newSession(t, Options{WorkDir: dir, Reports: []string{"json=r.json"}})
	s.Result(json.RawMessage(`{"id":"X1","status":"completed"}`))
	s.Finish(0)
	b, _ := os.ReadFile(filepath.Join(dir, "r.json"))
	if string(b) != "{\"id\":\"X1\",\"status\":\"completed\"}\n" {
		t.Fatalf("got %q", b)
	}
}

func TestEmptyJUnitHasASuite(t *testing.T) {
	b, err := JUnit(Document{Title: "agents list"})
	if err != nil || !strings.Contains(string(b), `<testsuite name="agents list"`) {
		t.Fatalf("%v %s", err, b)
	}
}

func TestDeprecatedAndSkewAreWarnings(t *testing.T) {
	s, out := newSession(t, Options{Provider: Provider{Name: "github"}, FailOn: []string{"deprecated"}})
	s.Deprecated("GET /agents is deprecated; sunset 2027-03-01")
	s.Skew("the workspace runs 5.140.2; the CLI knows 5.144.0")
	if !strings.Contains(out.String(), "::warning title=Deprecated::") || !strings.Contains(out.String(), "::warning title=Version skew::") {
		t.Fatalf("got %q", out.String())
	}
	if s.Finish(0).Exit != 3 {
		t.Fatal("--fail-on deprecated exits 3")
	}
}

func TestPhaseEndReturnsErr(t *testing.T) {
	s, out := newSession(t, Options{Provider: Provider{Name: "github"}})
	want := errors.New("boom")
	if err := s.Phase("p", "Planning").End(want); err != want {
		t.Fatal("End returns its error")
	}
	if !strings.Contains(out.String(), "::error title=Planning failed::") {
		t.Fatalf("got %q", out.String())
	}
	res := s.Finish(0)
	if res.Exit != 0 {
		t.Fatal("a failed phase alone doesn't change the exit code: the command's error does")
	}
}
