package ci

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ---------------------------------------------------------------------------------------------------------- GitLab

// gitlab writes collapsible sections (15.4):
//
//	\e[0Ksection_start:<unix time>:caitlyn_plan[collapsed=true]\r\e[0KPlanning
//	\e[0Ksection_end:<unix time>:caitlyn_plan\r\e[0K
//
// Detail phases are collapsed. GitLab can't open a section after it starts, so a failed phase is closed and its
// failure printed in a new section that is left open. Problems are printed with file and line; GitLab has no job
// summary, no runtime outputs and no runtime masking: --summary-file and --outputs-file (dotenv) are how those reach
// it, and printing a secret is refused.
type gitlab struct{ plain }

func (r *gitlab) Name() string { return "gitlab" }

var sectionUnsafe = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

// SectionName is a GitLab section name for a phase ID: caitlyn_<id>, with anything but letters, digits, '_', '.'
// and '-' replaced by '_'.
func SectionName(id string) string {
	s := sectionUnsafe.ReplaceAllString(id, "_")
	if s == "" {
		s = "phase"
	}
	return "caitlyn_" + s
}

func (r *gitlab) start(name, title string, collapsed bool, unix int64) {
	opt := ""
	if collapsed {
		opt = "[collapsed=true]"
	}
	r.printf("\x1b[0Ksection_start:%d:%s%s\r\x1b[0K%s\n", unix, name, opt, oneLine(title))
}

func (r *gitlab) end(name string, unix int64) {
	r.printf("\x1b[0Ksection_end:%d:%s\r\x1b[0K\n", unix, name)
}

func (r *gitlab) BeginPhase(p *Phase) {
	r.start(SectionName(p.ID), p.Title, p.Detail, p.Start.Unix())
}

func (r *gitlab) EndPhase(p *Phase) {
	name := SectionName(p.ID)
	r.end(name, p.End.Unix())
	if !p.Failed {
		return
	}
	failed := name + "_failed"
	r.start(failed, p.Title+" failed after "+seconds(p.Duration()), false, p.End.Unix())
	if p.Message != "" {
		r.printf("%s\n", strings.TrimRight(p.Message, "\n"))
	}
	r.end(failed, p.End.Unix())
}

func (r *gitlab) Mask(string) error { return ErrCannotMask }

// ---------------------------------------------------------------------------------------------------------- GitHub

// github writes workflow commands (::group::, ::error file=…::, ::add-mask::), appends the summary to
// $GITHUB_STEP_SUMMARY under its 1 MiB limit, and outputs to $GITHUB_OUTPUT.
type github struct{ plain }

func (r *github) Name() string { return "github" }

// githubData escapes a workflow command's message, as @actions/core does.
func githubData(s string) string {
	s = strings.ReplaceAll(s, "%", "%25")
	s = strings.ReplaceAll(s, "\r", "%0D")
	return strings.ReplaceAll(s, "\n", "%0A")
}

// githubProperty escapes a workflow command's property value.
func githubProperty(s string) string {
	s = githubData(s)
	s = strings.ReplaceAll(s, ":", "%3A")
	return strings.ReplaceAll(s, ",", "%2C")
}

func (r *github) BeginPhase(p *Phase) { r.printf("::group::%s\n", githubData(oneLine(p.Title))) }

func (r *github) EndPhase(p *Phase) {
	r.printf("::endgroup::\n")
	if p.Failed {
		msg := p.Title + " failed after " + seconds(p.Duration())
		if p.Message != "" {
			msg += ": " + p.Message
		}
		r.printf("::error title=%s::%s\n", githubProperty(p.Title+" failed"), githubData(msg))
	}
}

func (r *github) Problem(p Problem) {
	sev := p.Severity
	if sev == "" {
		sev = SeverityError
	}
	var props []string
	if p.File != "" {
		props = append(props, "file="+githubProperty(p.File))
		if p.Line > 0 {
			props = append(props, fmt.Sprintf("line=%d", p.Line))
			if p.Column > 0 {
				props = append(props, fmt.Sprintf("col=%d", p.Column))
			}
		}
	}
	if p.Title != "" {
		props = append(props, "title="+githubProperty(p.Title))
	}
	sep := ""
	if len(props) > 0 {
		sep = " "
	}
	r.printf("::%s%s%s::%s\n", sev, sep, strings.Join(props, ","), githubData(p.Message))
}

// StepSummaryLimit is GitHub's limit on one step's summary: 1 MiB.
const StepSummaryLimit = 1 << 20

func (r *github) Summary(markdown string, failed bool) error {
	path, ok := r.o.Lookup("GITHUB_STEP_SUMMARY")
	if !ok || path == "" {
		return nil
	}
	used := int64(0)
	if st, err := os.Stat(path); err == nil {
		used = st.Size()
	}
	text := Truncate(markdown, StepSummaryLimit-int(used), r.o.SummaryLink)
	if text == "" {
		return nil
	}
	return appendFile(path, ensureNewline(text))
}

var outputName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)

func (r *github) Output(name, value string) error {
	path, ok := r.o.Lookup("GITHUB_OUTPUT")
	if !ok || path == "" {
		return nil
	}
	return appendFile(path, GitHubOutput(name, value))
}

// GitHubOutput is one $GITHUB_OUTPUT entry: name=value, or the delimiter form for a value with line breaks, with a
// random delimiter that isn't in the value.
func GitHubOutput(name, value string) string {
	if !strings.ContainsAny(value, "\r\n") {
		return name + "=" + value + "\n"
	}
	var delim string
	for {
		b := make([]byte, 12)
		_, _ = rand.Read(b)
		delim = "ghadelimiter_" + hex.EncodeToString(b)
		if !strings.Contains(value, delim) {
			break
		}
	}
	return name + "<<" + delim + "\n" + value + "\n" + delim + "\n"
}

func (r *github) Mask(secret string) error {
	for _, line := range strings.Split(strings.ReplaceAll(secret, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) != "" {
			r.printf("::add-mask::%s\n", githubData(line))
		}
	}
	return nil
}

// ---------------------------------------------------------------------------------------------------------- Buildkite

// buildkite writes groups (--- collapsed, +++ open; ^^^ +++ reopens the previous group when it failed), and runs
// buildkite-agent for the annotation (annotate), outputs (meta-data set) and masking (redactor add), each with its
// value on stdin so it never appears in a process list.
type buildkite struct{ plain }

func (r *buildkite) Name() string { return "buildkite" }

func (r *buildkite) BeginPhase(p *Phase) {
	marker := "+++"
	if p.Detail {
		marker = "---"
	}
	r.printf("%s %s\n", marker, oneLine(p.Title))
}

func (r *buildkite) EndPhase(p *Phase) {
	if !p.Failed {
		r.printf("%s %s done in %s\n", clock(p.End), oneLine(p.Title), seconds(p.Duration()))
		return
	}
	msg := ""
	if p.Message != "" {
		msg = ": " + oneLine(p.Message)
	}
	r.printf("%s %s failed after %s%s\n", clock(p.End), oneLine(p.Title), seconds(p.Duration()), msg)
	r.printf("^^^ +++\n")
}

// AnnotationLimit is Buildkite's limit on an annotation's body: 1 MiB.
const AnnotationLimit = 1 << 20

func (r *buildkite) Summary(markdown string, failed bool) error {
	style := "success"
	if failed {
		style = "error"
	}
	body := Truncate(markdown, AnnotationLimit, r.o.SummaryLink)
	return r.o.Exec(context.Background(), "buildkite-agent", []string{"annotate", "--context", "caitlyn", "--style", style}, strings.NewReader(body))
}

func (r *buildkite) Output(name, value string) error {
	return r.o.Exec(context.Background(), "buildkite-agent", []string{"meta-data", "set", name}, strings.NewReader(value))
}

func (r *buildkite) Mask(secret string) error {
	if err := r.o.Exec(context.Background(), "buildkite-agent", []string{"redactor", "add"}, strings.NewReader(secret)); err != nil {
		return fmt.Errorf("%w: %v", ErrCannotMask, err)
	}
	return nil
}

// ---------------------------------------------------------------------------------------------------------- Azure

// azure writes ##[group] and ##vso logging commands: task.logissue for problems, task.uploadsummary for the summary
// (a file), task.setvariable for outputs and task.setsecret for masking.
type azure struct{ plain }

func (r *azure) Name() string { return "azure" }

// azureData escapes a logging command's message.
func azureData(s string) string {
	s = strings.ReplaceAll(s, "%", "%AZP25")
	s = strings.ReplaceAll(s, "\r", "%0D")
	return strings.ReplaceAll(s, "\n", "%0A")
}

// azureProperty escapes a logging command's property value.
func azureProperty(s string) string {
	s = azureData(s)
	s = strings.ReplaceAll(s, ";", "%3B")
	return strings.ReplaceAll(s, "]", "%5D")
}

func (r *azure) BeginPhase(p *Phase) { r.printf("##[group]%s\n", oneLine(p.Title)) }

func (r *azure) EndPhase(p *Phase) {
	r.printf("##[endgroup]\n")
	if p.Failed {
		msg := p.Title + " failed after " + seconds(p.Duration())
		if p.Message != "" {
			msg += ": " + p.Message
		}
		r.printf("##vso[task.logissue type=error]%s\n", azureData(msg))
	}
}

func (r *azure) Problem(p Problem) {
	typ := "warning"
	if p.Severity == "" || p.Severity == SeverityError {
		typ = "error"
	}
	props := []string{"type=" + typ}
	if p.File != "" {
		props = append(props, "sourcepath="+azureProperty(p.File))
		if p.Line > 0 {
			props = append(props, fmt.Sprintf("linenumber=%d", p.Line))
			if p.Column > 0 {
				props = append(props, fmt.Sprintf("columnnumber=%d", p.Column))
			}
		}
	}
	msg := p.Message
	if p.Title != "" {
		msg = p.Title + ": " + msg
	}
	r.printf("##vso[task.logissue %s]%s\n", strings.Join(props, ";"), azureData(msg))
}

func (r *azure) Summary(markdown string, failed bool) error {
	dir := r.o.TempDir
	if v, ok := r.o.Lookup("AGENT_TEMPDIRECTORY"); ok && v != "" {
		dir = v
	}
	f, err := os.CreateTemp(dir, "caitlyn-summary-*.md")
	if err != nil {
		return err
	}
	if _, err := f.WriteString(markdown); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	abs, _ := filepath.Abs(f.Name())
	r.printf("##vso[task.uploadsummary]%s\n", azureData(abs))
	return nil
}

func (r *azure) Output(name, value string) error {
	r.printf("##vso[task.setvariable variable=%s;isOutput=true]%s\n", azureProperty(name), azureData(value))
	return nil
}

func (r *azure) Mask(secret string) error {
	r.printf("##vso[task.setsecret]%s\n", azureData(secret))
	return nil
}

// ---------------------------------------------------------------------------------------------------------- helpers

func appendFile(path, text string) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(text); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func ensureNewline(s string) string {
	if strings.HasSuffix(s, "\n") {
		return s
	}
	return s + "\n"
}

// Truncate keeps markdown within limit bytes. When it must cut, it cuts at a line break, on a whole character, and
// ends with a note that it did, naming link when there is one. It returns "" when not even the note fits.
func Truncate(markdown string, limit int, link string) string {
	if len(markdown) <= limit {
		return markdown
	}
	note := "\n\n_The summary was cut to fit the step summary's 1 MiB limit._\n"
	if link != "" {
		note = "\n\n_The summary was cut to fit the step summary's 1 MiB limit. The full summary: " + link + "_\n"
	}
	keep := limit - len(note)
	if keep <= 0 {
		return ""
	}
	cut := markdown[:keep]
	if i := strings.LastIndexByte(cut, '\n'); i > 0 {
		cut = cut[:i]
	}
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + note
}
