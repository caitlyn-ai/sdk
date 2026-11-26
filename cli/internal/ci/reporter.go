package ci

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Reporter is how a run talks to its CI system (15.4). Commands never call it directly: they use a Session, which
// keeps what they report for the --report, --summary-file and --outputs-file files and hands each event to the
// Reporter of the detected provider.
type Reporter interface {
	// Name is the back-end: gitlab, github, buildkite, azure, plain or off.
	Name() string
	// BeginPhase opens a phase: a collapsible section in the job log where the provider has them.
	BeginPhase(p *Phase)
	// EndPhase closes it. A failed phase is left open (or reopened) where the provider allows, with the failure.
	EndPhase(p *Phase)
	// Problem reports a problem tied to a file and line, as an annotation where the provider has them.
	Problem(p Problem)
	// Line prints one plain progress line.
	Line(text string)
	// Summary publishes the run's Markdown summary natively (the step summary, an annotation, an uploaded file).
	// GitLab has no job summary, so its back-end does nothing: --summary-file is how a summary reaches GitLab.
	Summary(markdown string, failed bool) error
	// Output sets a value for later steps or jobs. GitLab has no runtime command for it: --outputs-file is how.
	Output(name, value string) error
	// Mask hides a secret in the rest of the job's log before it is printed. ErrCannotMask when the provider can't.
	Mask(secret string) error
}

// ErrCannotMask is returned by a Reporter whose provider has no runtime masking (GitLab).
var ErrCannotMask = errors.New("this CI system can't mask a value at run time")

// Phase is one step of a command's work (hash, plan, upload, process; one per agent in apply).
type Phase struct {
	// ID names the phase in markers that need a name (GitLab's section names): letters, digits, '_', '.' and '-'.
	ID string
	// Title is what the log shows.
	Title string
	// Detail phases are collapsed in the job log; the others are shown open.
	Detail bool
	Start  time.Time
	End    time.Time
	// Failed is set when the phase ended in failure; Message says why.
	Failed  bool
	Message string
}

// Duration is how long the phase took (0 while it runs).
func (p *Phase) Duration() time.Duration {
	if p.End.IsZero() {
		return 0
	}
	return p.End.Sub(p.Start)
}

// Severity of a problem.
type Severity string

// The severities, as GitHub names them. Azure has no notice: it is printed as a warning there.
const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
	SeverityNotice  Severity = "notice"
)

// Problem is a problem tied to a file: a configuration member that isn't one, a variable missing, a deprecation.
type Problem struct {
	Severity Severity `json:"severity"`
	// File is relative to the repository's root, as the annotation needs it. Empty for a problem with no file.
	File   string `json:"file,omitempty"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
	// Title is short (GitHub shows it as the annotation's heading).
	Title   string `json:"title,omitempty"`
	Message string `json:"message"`
}

// String is the plain form, compiler style: file:line:column: severity: title: message.
func (p Problem) String() string {
	var b strings.Builder
	if p.File != "" {
		b.WriteString(p.File)
		if p.Line > 0 {
			fmt.Fprintf(&b, ":%d", p.Line)
			if p.Column > 0 {
				fmt.Fprintf(&b, ":%d", p.Column)
			}
		}
		b.WriteString(": ")
	}
	sev := p.Severity
	if sev == "" {
		sev = SeverityError
	}
	b.WriteString(string(sev))
	b.WriteString(": ")
	if p.Title != "" {
		b.WriteString(p.Title)
		b.WriteString(": ")
	}
	b.WriteString(oneLine(p.Message))
	return b.String()
}

// Execer runs a provider's helper (buildkite-agent) with stdin. A seam, so tests need no binary.
type Execer func(ctx context.Context, name string, args []string, stdin io.Reader) error

// RunCommand is the real Execer: it runs the program with a 30-second limit, and folds its stderr into the error.
func RunCommand(ctx context.Context, name string, args []string, stdin io.Reader) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, name, args...)
	c.Stdin = stdin
	var stderr bytes.Buffer
	c.Stderr = &stderr
	if err := c.Run(); err != nil {
		if s := strings.TrimSpace(stderr.String()); s != "" {
			return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, s)
		}
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

// ReporterOptions are what a back-end needs from the environment.
type ReporterOptions struct {
	// Out is where log markers go: stderr, so stdout keeps only data. Every provider reads workflow commands and
	// section markers from both streams.
	Out io.Writer
	// Lookup reads the environment ($GITHUB_STEP_SUMMARY, $GITHUB_OUTPUT, the Azure temp directory).
	Lookup func(string) (string, bool)
	Now    func() time.Time
	Exec   Execer
	// TempDir is where a summary file goes when the provider needs a file and --summary-file wasn't given (Azure).
	TempDir string
	// SummaryLink is printed in a truncated step summary, pointing at the full one (an artifact, a run's page).
	SummaryLink string
}

// Formats --ci-format takes. auto (or empty) is the provider's own integration in CI, and nothing outside it.
var Formats = []string{"auto", "plain", "off"}

// NewReporter picks the back-end: the provider's integration for format auto, plain lines for plain (and for CI
// systems with no integration), and nothing for off or outside CI.
func NewReporter(p Provider, format string, o ReporterOptions) (Reporter, error) {
	if o.Out == nil {
		o.Out = io.Discard
	}
	if o.Lookup == nil {
		o.Lookup = func(string) (string, bool) { return "", false }
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Exec == nil {
		o.Exec = RunCommand
	}
	if o.TempDir == "" {
		o.TempDir = os.TempDir()
	}
	switch format {
	case "", "auto":
	case "plain":
		return &plain{o: o}, nil
	case "off":
		return off{}, nil
	default:
		return nil, fmt.Errorf("--ci-format takes plain or off (or auto), not %q", format)
	}
	if !p.In() {
		return off{}, nil
	}
	switch p.Name {
	case "gitlab":
		return &gitlab{plain: plain{o: o}}, nil
	case "github":
		return &github{plain: plain{o: o}}, nil
	case "buildkite":
		return &buildkite{plain: plain{o: o}}, nil
	case "azure":
		return &azure{plain: plain{o: o}}, nil
	}
	return &plain{o: o}, nil
}

// oneLine folds a message onto one line for the formats that can't hold more.
func oneLine(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\n", " ")
}

// clock is the time of day prefixed to plain lines.
func clock(t time.Time) string { return t.Format("15:04:05") }

// seconds formats a duration as the job log shows it: 0.2 s, 52.3 s, 3 min 4 s.
func seconds(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%.1f s", d.Seconds())
	}
	d = d.Round(time.Second)
	return fmt.Sprintf("%d min %d s", int(d.Minutes()), int(d.Seconds())%60)
}

// off reports nothing: --ci-format off, and runs outside CI (people get the design system's own output there).
type off struct{}

func (off) Name() string                { return "off" }
func (off) BeginPhase(*Phase)           {}
func (off) EndPhase(*Phase)             {}
func (off) Problem(Problem)             {}
func (off) Line(string)                 {}
func (off) Summary(string, bool) error  { return nil }
func (off) Output(string, string) error { return nil }
func (off) Mask(string) error           { return nil }

// plain is timestamped lines: --ci-format plain, and CI systems with no integration (CircleCI, Jenkins, Bitbucket,
// CodeBuild, any other). The provider back-ends embed it for what they print the same way.
type plain struct{ o ReporterOptions }

func (r *plain) Name() string { return "plain" }

func (r *plain) printf(format string, args ...any) { fmt.Fprintf(r.o.Out, format, args...) }

func (r *plain) BeginPhase(p *Phase) { r.printf("%s %s\n", clock(p.Start), oneLine(p.Title)) }

func (r *plain) EndPhase(p *Phase) {
	if p.Failed {
		msg := ""
		if p.Message != "" {
			msg = ": " + oneLine(p.Message)
		}
		r.printf("%s %s failed after %s%s\n", clock(p.End), oneLine(p.Title), seconds(p.Duration()), msg)
		return
	}
	r.printf("%s %s done in %s\n", clock(p.End), oneLine(p.Title), seconds(p.Duration()))
}

func (r *plain) Problem(p Problem) { r.printf("%s\n", p.String()) }

func (r *plain) Line(text string) { r.printf("%s %s\n", clock(r.o.Now()), oneLine(text)) }

func (r *plain) Summary(string, bool) error { return nil }

func (r *plain) Output(string, string) error { return nil }

// Mask can't hide anything in a CI system the CLI doesn't know, but --show-secret was given: printing is allowed.
func (r *plain) Mask(string) error { return nil }
