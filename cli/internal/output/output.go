// Package output prints what commands return (the CLI design, section 4): tables and detail views for people on a
// terminal, the server's own JSON for everything else, JSON Lines for streams, YAML and text on request, and
// --query (JMESPath) and --jq filters over any of it.
package output

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// The formats.
const (
	Table = "table"
	JSON  = "json"
	JSONL = "jsonl"
	YAML  = "yaml"
	Text  = "text"
)

// Formats lists them, for flag completion and validation.
var Formats = []string{Table, JSON, JSONL, YAML, Text}

// Resolve decides the output format (4.1 and 18.2): --output; then CAITLYN_OUTPUT; then, under an AI agent, the
// profile's agent_output (JSON by default); then output from the project file or profile; then table on a terminal
// and JSON when piped. A filter (--query, --jq) with no explicit format prints JSON.
func Resolve(f *cmdutil.Factory) (string, error) {
	g := f.Globals
	pick := func(v string) (string, bool, error) {
		v = strings.ToLower(strings.TrimSpace(v))
		switch v {
		case "", "auto":
			return "", false, nil
		case Table, JSON, JSONL, YAML, Text:
			return v, true, nil
		}
		return "", false, cmdutil.Usagef("%q is not an output format: use table, json, jsonl, yaml or text", v)
	}
	if v, ok, err := pick(g.Output); err != nil || ok {
		return v, err
	}
	cfg, err := f.Config()
	if err != nil {
		return "", err
	}
	out := cfg.Get("output")
	if out.Origin == config.FromEnv {
		if v, ok, err := pick(out.Value); err != nil || ok {
			return v, err
		}
	}
	if f.Agent.On {
		ao := cfg.Get("agent_output")
		if strings.ToLower(ao.Value) != "same" {
			if v, ok, err := pick(ao.Value); err != nil || ok {
				return v, err
			}
			return JSON, nil
		}
	}
	if v, ok, err := pick(out.Value); err != nil || ok {
		return v, err
	}
	if g.Query != "" || g.JQ != "" {
		return JSON, nil
	}
	if f.IO.IsStdoutTTY() {
		return Table, nil
	}
	return JSON, nil
}

// Printer prints one command's results.
type Printer struct {
	F      *cmdutil.Factory
	U      *ui.UI
	Format string
	// Human is true when output is for people (table, or text on a terminal).
	Human bool
	m     *spec.Manifest
	o     *spec.Overlay
}

// New returns a printer for the command's format.
func New(f *cmdutil.Factory, u *ui.UI) (*Printer, error) {
	format, err := Resolve(f)
	if err != nil {
		return nil, err
	}
	p := &Printer{F: f, U: u, Format: format, Human: format == Table, m: f.Manifest(), o: f.Overlay()}
	return p, nil
}

func (p *Printer) out() io.Writer { return p.F.IO.Out }

// Filtered reports whether --query or --jq is in use.
func (p *Printer) Filtered() bool { return p.F.Globals.Query != "" || p.F.Globals.JQ != "" }

// Raw prints a JSON value as the server sent it: re-indented on a terminal, as received otherwise, after any
// filter. In YAML, it's converted, keeping member order; in table and text formats a thing becomes a detail view.
func (p *Printer) Raw(raw []byte, shape string) error {
	raw = bytes.TrimSpace(raw)
	if p.Filtered() {
		return p.filter(raw)
	}
	switch p.Format {
	case JSON, JSONL:
		return p.writeJSON(raw)
	case YAML:
		return writeYAML(p.out(), raw)
	case Text:
		return p.text(raw)
	default:
		return p.detail(raw, shape)
	}
}

// Value prints a value the CLI made itself (not the server's bytes).
func (p *Printer) Value(v any, shape string) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return p.Raw(b, shape)
}

func (p *Printer) writeJSON(raw []byte) error {
	if p.F.IO.IsStdoutTTY() && p.Format == JSON {
		var buf bytes.Buffer
		if err := json.Indent(&buf, raw, "", "  "); err == nil {
			raw = buf.Bytes()
		}
	}
	if p.Format == JSONL {
		var buf bytes.Buffer
		if err := json.Compact(&buf, raw); err == nil {
			raw = buf.Bytes()
		}
	}
	_, err := fmt.Fprintf(p.out(), "%s\n", raw)
	return err
}

// Event prints one stream event as a JSON line: {"type", "id", "data"} (4.1).
func (p *Printer) Event(typ, id string, data []byte) error {
	ev := struct {
		Type string          `json:"type"`
		ID   string          `json:"id,omitempty"`
		Data json.RawMessage `json:"data,omitempty"`
	}{typ, id, json.RawMessage(bytes.TrimSpace(data))}
	if len(ev.Data) == 0 || !json.Valid(ev.Data) {
		ev.Data = nil
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if p.Filtered() {
		return p.filter(b)
	}
	_, err = fmt.Fprintf(p.out(), "%s\n", b)
	return err
}

// ItemShape is the shape of a list's items, from its operation's output (ListDocuments' items are Document).
func (p *Printer) ItemShape(op *spec.Operation) string {
	if op == nil || op.Paginated == nil {
		return ""
	}
	if m := op.OutputMember(op.Paginated.Items); m != nil && m.Type.Type == "list" && m.Type.Member != nil {
		return m.Type.Member.Ref
	}
	return ""
}

// ThingShape is the shape a call returns: its payload member's (GetDocument returns a Document), else the output's.
func (p *Printer) ThingShape(op *spec.Operation) string {
	if op == nil {
		return ""
	}
	if m := op.Payload(); m != nil {
		return m.Type.Ref
	}
	return ""
}
