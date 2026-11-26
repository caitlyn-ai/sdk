package ci

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ReportFormats are the formats --report takes (15.5), plus annotations: GitLab's artifacts:reports:annotations
// JSON, which carries the run's links (15.4).
var ReportFormats = []string{"junit", "markdown", "json", "annotations"}

// ReportSpec is one --report format=path.
type ReportSpec struct {
	Format string
	Path   string
}

// ParseReport checks one --report value.
func ParseReport(v string) (ReportSpec, error) {
	format, path, ok := strings.Cut(v, "=")
	format = strings.ToLower(strings.TrimSpace(format))
	if !ok || path == "" {
		return ReportSpec{}, fmt.Errorf("--report takes <format>=<path>, such as junit=report.xml, not %q", v)
	}
	for _, f := range ReportFormats {
		if f == format {
			if path == "-" {
				return ReportSpec{}, fmt.Errorf("--report writes to a file, not stdout: stdout carries the command's own output")
			}
			return ReportSpec{Format: format, Path: path}, nil
		}
	}
	return ReportSpec{}, fmt.Errorf("--report format %q is not one of %s", format, strings.Join(ReportFormats, ", "))
}

// Status of a test case.
type Status string

// The statuses a test case ends with.
const (
	Passed  Status = "passed"
	Failed  Status = "failed"
	Skipped Status = "skipped"
)

// TestCase is one checked item: a sync item, a policy rule reviewed, a resource in a plan (15.5).
type TestCase struct {
	// Suite groups cases (the command, or an agent in apply). Empty: the session's title.
	Suite    string        `json:"suite,omitempty"`
	Name     string        `json:"name"`
	Status   Status        `json:"status"`
	Message  string        `json:"message,omitempty"`
	Detail   string        `json:"detail,omitempty"`
	File     string        `json:"file,omitempty"`
	Line     int           `json:"line,omitempty"`
	Duration time.Duration `json:"-"`
}

// Link is a link to Caitlyn: the run, the batch, the agent's history.
type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// Output is a value for later steps or jobs.
type Output struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Section is one part of the Markdown summary.
type Section struct {
	Heading  string `json:"heading,omitempty"`
	Markdown string `json:"markdown"`
}

// Options build a Session.
type Options struct {
	Provider Provider
	// Format is --ci-format: auto (""), plain or off.
	Format string
	// Out is stderr.
	Out    io.Writer
	Lookup func(string) (string, bool)
	Now    func() time.Time
	Exec   Execer
	// WorkDir resolves relative report, summary and outputs paths ("" is the process's).
	WorkDir     string
	Reports     []string
	SummaryFile string
	OutputsFile string
	FailOn      []string
	ShowSecret  bool
	// Title heads the summary and names the JUnit suite (the command path).
	Title string
	// Version is the CLI's, for the summary's footer.
	Version string
}

// Session is what commands report to: phases, test cases, problems, outputs, links and a summary. It hands each to
// the provider's Reporter as it happens, and writes the files the person asked for when the run finishes.
type Session struct {
	o        Options
	reporter Reporter
	native   Reporter
	reports  []ReportSpec
	fail     failOn

	mu         sync.Mutex
	phases     []*Phase
	cases      []TestCase
	problems   []Problem
	outputs    []Output
	links      []Link
	sections   []Section
	result     any
	held       map[string]bool
	lastLine   time.Time
	finished   bool
	exit       int
	failedHits []string
}

// NewSession checks the flags and builds the session.
func NewSession(o Options) (*Session, error) {
	if o.Out == nil {
		o.Out = io.Discard
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Lookup == nil {
		o.Lookup = func(string) (string, bool) { return "", false }
	}
	ro := ReporterOptions{Out: o.Out, Lookup: o.Lookup, Now: o.Now, Exec: o.Exec}
	r, err := NewReporter(o.Provider, o.Format, ro)
	if err != nil {
		return nil, err
	}
	// Masking uses the provider's own command whatever --ci-format says: it protects the log, it isn't decoration.
	native, _ := NewReporter(o.Provider, "auto", ro)
	s := &Session{o: o, reporter: r, native: native, held: map[string]bool{}}
	for _, v := range o.Reports {
		spec, err := ParseReport(v)
		if err != nil {
			return nil, err
		}
		s.reports = append(s.reports, spec)
	}
	given, err := ParseFailOn(o.FailOn)
	if err != nil {
		return nil, err
	}
	s.fail = failOn{given: given, allowed: map[string]bool{}}
	for _, g := range GenericConditions {
		s.fail.allowed[g] = true
	}
	return s, nil
}

// Reporter is the back-end in use (gitlab, github, buildkite, azure, plain or off).
func (s *Session) Reporter() Reporter { return s.reporter }

// SetTitle names the run (the summary's heading and the JUnit suite).
func (s *Session) SetTitle(t string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.o.Title = t
}

// AcceptFailOn says which --fail-on conditions the command takes and its defaults. A condition the person gave
// that the command doesn't take is returned as an error (a usage error).
func (s *Session) AcceptFailOn(allowed, defaults []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range allowed {
		s.fail.allowed[a] = true
	}
	s.fail.defaults = append([]string(nil), defaults...)
	s.fail.declared = true
	for _, g := range s.fail.given {
		if !s.fail.allowed[g] {
			takes := append(append([]string(nil), allowed...), GenericConditions...)
			return fmt.Errorf("--fail-on %s doesn't apply to this command; it takes %s", g, strings.Join(takes, ", "))
		}
	}
	return nil
}

// Ignored is the --fail-on conditions the command never said it takes: they have no effect.
func (s *Session) Ignored() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, g := range s.fail.given {
		if !s.fail.allowed[g] {
			out = append(out, g)
		}
	}
	return out
}

// PhaseHandle is a phase in progress.
type PhaseHandle struct {
	s *Session
	p *Phase
}

// PhaseOption adjusts a phase.
type PhaseOption func(*Phase)

// Detail collapses the phase in the job log: hashing, uploading, the parts people rarely need to read.
func Detail() PhaseOption { return func(p *Phase) { p.Detail = true } }

// Phase opens a phase. End it with Done or Fail (or End with the error).
func (s *Session) Phase(id, title string, opts ...PhaseOption) *PhaseHandle {
	p := &Phase{ID: id, Title: title, Start: s.o.Now()}
	for _, o := range opts {
		o(p)
	}
	s.mu.Lock()
	s.phases = append(s.phases, p)
	s.mu.Unlock()
	s.reporter.BeginPhase(p)
	return &PhaseHandle{s: s, p: p}
}

// Done ends the phase successfully.
func (h *PhaseHandle) Done() { h.end(false, "") }

// Fail ends the phase as failed, saying why.
func (h *PhaseHandle) Fail(message string) { h.end(true, message) }

// End ends the phase: failed with err's message when err isn't nil. It returns err, so `return ph.End(err)` works.
func (h *PhaseHandle) End(err error) error {
	if err != nil {
		h.end(true, err.Error())
	} else {
		h.end(false, "")
	}
	return err
}

func (h *PhaseHandle) end(failed bool, msg string) {
	h.s.mu.Lock()
	if !h.p.End.IsZero() {
		h.s.mu.Unlock()
		return
	}
	h.p.End = h.s.o.Now()
	h.p.Failed = failed
	h.p.Message = msg
	h.s.mu.Unlock()
	h.s.reporter.EndPhase(h.p)
}

// Problem reports a problem tied to a file: an annotation where the provider has them.
func (s *Session) Problem(p Problem) {
	if p.Severity == "" {
		p.Severity = SeverityError
	}
	s.mu.Lock()
	s.problems = append(s.problems, p)
	s.mu.Unlock()
	s.reporter.Problem(p)
}

// Deprecated reports a Deprecation or Sunset header: a warning, and the deprecated condition for --fail-on.
func (s *Session) Deprecated(message string) {
	s.Hold("deprecated")
	s.Problem(Problem{Severity: SeverityWarning, Title: "Deprecated", Message: message})
}

// Skew reports a server older than the CLI's model: a warning, and the skew condition for --fail-on.
func (s *Session) Skew(message string) {
	s.Hold("skew")
	s.Problem(Problem{Severity: SeverityWarning, Title: "Version skew", Message: message})
}

// Case records a test case for --report junit (and the summary's table).
func (s *Session) Case(c TestCase) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cases = append(s.cases, c)
}

// Output sets a value for later steps: $GITHUB_OUTPUT, Buildkite meta-data, an Azure output variable, and
// --outputs-file (dotenv, for GitLab's artifacts:reports:dotenv). A later value for the same name replaces it.
func (s *Session) Output(name, value string) error {
	if !outputName.MatchString(name) {
		return fmt.Errorf("output name %q must be letters, digits, '_' and '-', not starting with a digit", name)
	}
	s.mu.Lock()
	replaced := false
	for i := range s.outputs {
		if s.outputs[i].Name == name {
			s.outputs[i].Value = value
			replaced = true
		}
	}
	if !replaced {
		s.outputs = append(s.outputs, Output{Name: name, Value: value})
	}
	s.mu.Unlock()
	return s.reporter.Output(name, value)
}

// Link adds a link to Caitlyn, shown in the summary and in GitLab's annotations report.
func (s *Session) Link(label, url string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.links = append(s.links, Link{Label: label, URL: url})
}

// Summary adds a section to the run's Markdown summary.
func (s *Session) Summary(heading, markdown string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sections = append(s.sections, Section{Heading: heading, Markdown: markdown})
}

// Result is what --report json writes: the full result, as -o json would print it (json.RawMessage or []byte
// are written as they are).
func (s *Session) Result(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.result = v
}

// Hold records that a --fail-on condition holds (changes, failed, unresolved, …).
func (s *Session) Hold(condition string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.held[condition] = true
}

// ProgressInterval is the least time between two progress lines in CI (15.2).
const ProgressInterval = 10 * time.Second

// Progress prints a timestamped progress line, at most one every 10 s; the rest are dropped. Nothing outside CI,
// where the design system's progress bar does this.
func (s *Session) Progress(format string, args ...any) {
	s.mu.Lock()
	now := s.o.Now()
	if !s.lastLine.IsZero() && now.Sub(s.lastLine) < ProgressInterval {
		s.mu.Unlock()
		return
	}
	s.lastLine = now
	s.mu.Unlock()
	s.reporter.Line(fmt.Sprintf(format, args...))
}

// SecretError is why a secret may not be printed.
type SecretError struct {
	// NeedsFlag: --show-secret would allow it.
	NeedsFlag bool
	Provider  string
	Err       error
}

func (e *SecretError) Error() string {
	if e.NeedsFlag {
		return "printing a secret in CI needs --show-secret"
	}
	return fmt.Sprintf("%s can't mask a secret, so it isn't printed", e.Provider)
}

func (e *SecretError) Unwrap() error { return e.Err }

// Secret is called before printing a secret Caitlyn returned (15.2). Outside CI it allows it. In CI it refuses
// unless --show-secret was given; with it, the value is masked first where the provider can (GitHub, Azure,
// Buildkite), and refused where it can't (GitLab).
func (s *Session) Secret(value string) error {
	if !s.o.Provider.In() {
		return nil
	}
	if !s.o.ShowSecret {
		return &SecretError{NeedsFlag: true, Provider: s.o.Provider.Name}
	}
	if err := s.native.Mask(value); err != nil {
		return &SecretError{Provider: s.o.Provider.Name, Err: err}
	}
	return nil
}

// failedLocked reports whether anything failed: a phase or a test case. A problem alone decides nothing: the
// command's exit code says whether it was fatal.
func (s *Session) failedLocked() bool {
	for _, p := range s.phases {
		if p.Failed {
			return true
		}
	}
	for _, c := range s.cases {
		if c.Status == Failed {
			return true
		}
	}
	return false
}

// FinishResult is what Finish decided.
type FinishResult struct {
	// Exit is the run's exit code: the command's own when it failed, else what --fail-on calls for.
	Exit int
	// FailedOn are the --fail-on conditions that held and decided Exit.
	FailedOn []string
	// Errors are files that couldn't be written; the run's exit code is not changed for them.
	Errors []error
}

// Finish applies --fail-on to the command's exit code, publishes the summary and writes the report, summary and
// outputs files. It runs once; later calls return the first result.
func (s *Session) Finish(code int) FinishResult {
	s.mu.Lock()
	if s.finished {
		r := FinishResult{Exit: s.exit, FailedOn: s.failedHits}
		s.mu.Unlock()
		return r
	}
	s.finished = true
	exit := code
	var hits []string
	if code == 0 {
		exit, hits = s.fail.exitFor(s.held)
	}
	s.exit, s.failedHits = exit, hits
	failed := exit != 0 || s.failedLocked()
	doc := s.documentLocked(exit)
	s.mu.Unlock()

	var errs []error
	md := Markdown(doc)
	if err := s.reporter.Summary(md, failed); err != nil {
		errs = append(errs, fmt.Errorf("the CI summary: %w", err))
	}
	if s.o.SummaryFile != "" {
		if err := s.write(s.o.SummaryFile, []byte(md)); err != nil {
			errs = append(errs, err)
		}
	}
	if s.o.OutputsFile != "" {
		if err := s.write(s.o.OutputsFile, []byte(Dotenv(doc.Outputs))); err != nil {
			errs = append(errs, err)
		}
	}
	for _, r := range s.reports {
		var b []byte
		var err error
		switch r.Format {
		case "junit":
			b, err = JUnit(doc)
		case "markdown":
			b = []byte(md)
		case "json":
			b, err = JSON(doc, s.result)
		case "annotations":
			b, err = Annotations(doc)
		}
		if err == nil {
			err = s.write(r.Path, b)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("--report %s: %w", r.Format, err))
		}
	}
	return FinishResult{Exit: exit, FailedOn: hits, Errors: errs}
}

func (s *Session) write(path string, b []byte) error {
	if !filepath.IsAbs(path) && s.o.WorkDir != "" {
		path = filepath.Join(s.o.WorkDir, path)
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// Document is everything the session holds, for the report writers.
type Document struct {
	Title    string     `json:"title"`
	Version  string     `json:"cliVersion,omitempty"`
	Provider string     `json:"ci,omitempty"`
	ExitCode int        `json:"exitCode"`
	Failed   bool       `json:"failed"`
	FailedOn []string   `json:"failedOn,omitempty"`
	Started  time.Time  `json:"started"`
	Finished time.Time  `json:"finished"`
	Phases   []Phase    `json:"phases,omitempty"`
	Cases    []TestCase `json:"cases,omitempty"`
	Problems []Problem  `json:"problems,omitempty"`
	Outputs  []Output   `json:"outputs,omitempty"`
	Links    []Link     `json:"links,omitempty"`
	Sections []Section  `json:"sections,omitempty"`
}

func (s *Session) documentLocked(exit int) Document {
	d := Document{
		Title: s.o.Title, Version: s.o.Version, Provider: s.o.Provider.Name, ExitCode: exit,
		Failed: exit != 0 || s.failedLocked(), FailedOn: s.failedHits, Finished: s.o.Now(),
		Cases: append([]TestCase(nil), s.cases...), Problems: append([]Problem(nil), s.problems...),
		Outputs: append([]Output(nil), s.outputs...), Links: append([]Link(nil), s.links...),
		Sections: append([]Section(nil), s.sections...),
	}
	if d.Title == "" {
		d.Title = "caitlyn"
	}
	d.Started = d.Finished
	for _, p := range s.phases {
		d.Phases = append(d.Phases, *p)
		if p.Start.Before(d.Started) {
			d.Started = p.Start
		}
	}
	return d
}
