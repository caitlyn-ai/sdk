package ci

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------------------------------------- JUnit

type junitSuites struct {
	XMLName  xml.Name     `xml:"testsuites"`
	Name     string       `xml:"name,attr"`
	Tests    int          `xml:"tests,attr"`
	Failures int          `xml:"failures,attr"`
	Errors   int          `xml:"errors,attr"`
	Skipped  int          `xml:"skipped,attr"`
	Time     string       `xml:"time,attr"`
	Suites   []junitSuite `xml:"testsuite"`
}

type junitSuite struct {
	Name      string      `xml:"name,attr"`
	Tests     int         `xml:"tests,attr"`
	Failures  int         `xml:"failures,attr"`
	Errors    int         `xml:"errors,attr"`
	Skipped   int         `xml:"skipped,attr"`
	Time      string      `xml:"time,attr"`
	Timestamp string      `xml:"timestamp,attr,omitempty"`
	Cases     []junitCase `xml:"testcase"`
}

type junitCase struct {
	Classname string        `xml:"classname,attr"`
	Name      string        `xml:"name,attr"`
	Time      string        `xml:"time,attr"`
	File      string        `xml:"file,attr,omitempty"`
	Line      string        `xml:"line,attr,omitempty"`
	Failure   *junitMessage `xml:"failure,omitempty"`
	Skipped   *junitMessage `xml:"skipped,omitempty"`
}

type junitMessage struct {
	Message string `xml:"message,attr,omitempty"`
	Type    string `xml:"type,attr,omitempty"`
	Body    string `xml:",chardata"`
}

func secs(d time.Duration) string { return strconv.FormatFloat(d.Seconds(), 'f', 3, 64) }

// JUnit writes one test case per checked item, grouped into a suite per Suite (the title when empty). GitLab's
// artifacts:reports:junit and GitHub's test-report actions read it.
func JUnit(d Document) ([]byte, error) {
	order := []string{}
	bySuite := map[string]*junitSuite{}
	total := junitSuites{Name: "caitlyn", Time: secs(d.Finished.Sub(d.Started))}
	for _, c := range d.Cases {
		name := c.Suite
		if name == "" {
			name = d.Title
		}
		s := bySuite[name]
		if s == nil {
			s = &junitSuite{Name: name, Timestamp: d.Started.UTC().Format(time.RFC3339)}
			bySuite[name] = s
			order = append(order, name)
		}
		jc := junitCase{Classname: name, Name: c.Name, Time: secs(c.Duration), File: c.File}
		if c.Line > 0 {
			jc.Line = strconv.Itoa(c.Line)
		}
		switch c.Status {
		case Failed:
			jc.Failure = &junitMessage{Message: oneLine(c.Message), Type: "failed", Body: c.Detail}
			s.Failures++
		case Skipped:
			jc.Skipped = &junitMessage{Message: oneLine(c.Message)}
			s.Skipped++
		}
		s.Tests++
		s.Cases = append(s.Cases, jc)
	}
	for _, name := range order {
		s := bySuite[name]
		var sd time.Duration
		for _, c := range d.Cases {
			if c.Suite == name || (c.Suite == "" && name == d.Title) {
				sd += c.Duration
			}
		}
		s.Time = secs(sd)
		total.Tests += s.Tests
		total.Failures += s.Failures
		total.Skipped += s.Skipped
		total.Suites = append(total.Suites, *s)
	}
	if len(total.Suites) == 0 {
		// A run with no checked items still gives the test widget a suite, so an empty report reads as "nothing ran".
		total.Suites = []junitSuite{{Name: d.Title, Time: "0.000", Timestamp: d.Started.UTC().Format(time.RFC3339)}}
	}
	var b bytes.Buffer
	b.WriteString(xml.Header)
	enc := xml.NewEncoder(&b)
	enc.Indent("", "  ")
	if err := enc.Encode(total); err != nil {
		return nil, err
	}
	b.WriteByte('\n')
	return b.Bytes(), nil
}

// ---------------------------------------------------------------------------------------------------------- Markdown

// mdCell escapes text for a Markdown table cell.
func mdCell(s string) string {
	s = oneLine(s)
	s = strings.ReplaceAll(s, "|", `\|`)
	return s
}

// MaxSummaryCases is how many test cases the summary's table lists; the rest are counted (the JUnit report has them all).
const MaxSummaryCases = 200

// Markdown is the run's summary (15.4): the result, the command's own sections, the checks, problems, outputs and
// links. GitHub-flavoured, for the step summary, a Buildkite annotation, an Azure summary or --summary-file.
func Markdown(d Document) string {
	var b strings.Builder
	result := "Succeeded"
	if d.Failed {
		result = "Failed"
	}
	fmt.Fprintf(&b, "## Caitlyn: %s\n\n", d.Title)
	fmt.Fprintf(&b, "**%s** (exit code %d", result, d.ExitCode)
	if len(d.FailedOn) > 0 {
		fmt.Fprintf(&b, ", --fail-on %s", strings.Join(d.FailedOn, ","))
	}
	b.WriteString(")\n")
	for _, s := range d.Sections {
		b.WriteString("\n")
		if s.Heading != "" {
			fmt.Fprintf(&b, "### %s\n\n", s.Heading)
		}
		b.WriteString(strings.TrimRight(s.Markdown, "\n"))
		b.WriteString("\n")
	}
	if len(d.Cases) > 0 {
		counts := map[Status]int{}
		for _, c := range d.Cases {
			counts[c.Status]++
		}
		fmt.Fprintf(&b, "\n### Checks\n\n%d passed, %d failed, %d skipped\n\n", counts[Passed], counts[Failed], counts[Skipped])
		b.WriteString("| Check | Result | Message |\n| --- | --- | --- |\n")
		// Failures first, so a long list still shows them
		cases := append([]TestCase(nil), d.Cases...)
		sort.SliceStable(cases, func(i, j int) bool { return rank(cases[i].Status) < rank(cases[j].Status) })
		for i, c := range cases {
			if i == MaxSummaryCases {
				fmt.Fprintf(&b, "\n%d more checks are in the JUnit report.\n", len(cases)-MaxSummaryCases)
				break
			}
			name := c.Name
			if c.Suite != "" && c.Suite != d.Title {
				name = c.Suite + ": " + name
			}
			fmt.Fprintf(&b, "| %s | %s | %s |\n", mdCell(name), c.Status, mdCell(c.Message))
		}
	}
	if len(d.Problems) > 0 {
		b.WriteString("\n### Problems\n\n")
		for _, p := range d.Problems {
			fmt.Fprintf(&b, "- %s\n", mdCell(p.String()))
		}
	}
	if len(d.Outputs) > 0 {
		b.WriteString("\n### Outputs\n\n| Name | Value |\n| --- | --- |\n")
		for _, o := range d.Outputs {
			fmt.Fprintf(&b, "| `%s` | %s |\n", o.Name, mdCell(o.Value))
		}
	}
	if len(d.Links) > 0 {
		b.WriteString("\n### Links\n\n")
		for _, l := range d.Links {
			fmt.Fprintf(&b, "- [%s](%s)\n", strings.ReplaceAll(l.Label, "]", `\]`), l.URL)
		}
	}
	if d.Version != "" {
		fmt.Fprintf(&b, "\n<sub>Caitlyn CLI %s</sub>\n", d.Version)
	}
	return b.String()
}

func rank(s Status) int {
	switch s {
	case Failed:
		return 0
	case Skipped:
		return 1
	}
	return 2
}

// ---------------------------------------------------------------------------------------------------------- JSON

// JSON is the full result, as -o json would print it, when the command gave one; otherwise the session's own
// document.
func JSON(d Document, result any) ([]byte, error) {
	var b []byte
	var err error
	switch r := result.(type) {
	case nil:
		b, err = json.MarshalIndent(d, "", "  ")
	case json.RawMessage:
		b = r
	case []byte:
		b = r
	default:
		b, err = json.MarshalIndent(r, "", "  ")
	}
	if err != nil {
		return nil, err
	}
	if len(b) == 0 || b[len(b)-1] != '\n' {
		b = append(b, '\n')
	}
	return b, nil
}

// ---------------------------------------------------------------------------------------------------------- annotations

// Annotations is GitLab's artifacts:reports:annotations: the run's links as external_link entries, shown on the job.
func Annotations(d Document) ([]byte, error) {
	type ext struct {
		Label string `json:"label"`
		URL   string `json:"url"`
	}
	type entry struct {
		ExternalLink ext `json:"external_link"`
	}
	entries := []entry{}
	for _, l := range d.Links {
		entries = append(entries, entry{ext(l)})
	}
	b, err := json.MarshalIndent(map[string][]entry{"caitlyn": entries}, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// ---------------------------------------------------------------------------------------------------------- dotenv

// Dotenv is --outputs-file: NAME=value lines, which GitLab's artifacts:reports:dotenv reads. GitLab's dotenv takes
// no multi-line values, so line breaks are written as \n, and a name is made a variable name ('-' becomes '_').
func Dotenv(outputs []Output) string {
	var b strings.Builder
	for _, o := range outputs {
		v := strings.ReplaceAll(o.Value, "\r\n", "\n")
		v = strings.ReplaceAll(v, "\n", `\n`)
		fmt.Fprintf(&b, "%s=%s\n", strings.ReplaceAll(o.Name, "-", "_"), v)
	}
	return b.String()
}
