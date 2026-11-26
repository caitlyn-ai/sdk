package output

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/itchyny/gojq"
	"github.com/jmespath-community/go-jmespath"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
)

// filter applies --jq (gojq, in-process, so no jq binary is needed) or --query (JMESPath, as the AWS CLI has it) to
// one JSON value. A string result prints as raw text, so `--query etag` prints a value ready to paste; anything
// else prints as JSON, one result per line for jq.
func (p *Printer) filter(raw []byte) error {
	v, err := decode(raw)
	if err != nil {
		return err
	}
	results, err := Apply(v, p.F.Globals.JQ, p.F.Globals.Query)
	if err != nil {
		return err
	}
	for _, r := range results {
		if err := p.writeResult(r); err != nil {
			return err
		}
	}
	return nil
}

// Apply runs the jq expression or the JMESPath query over v.
func Apply(v any, jq, query string) ([]any, error) {
	if jq != "" && query != "" {
		return nil, cmdutil.Usagef("--jq and --query can't be used together: pick one")
	}
	if jq != "" {
		q, err := gojq.Parse(jq)
		if err != nil {
			return nil, cmdutil.Usagef("--jq: %v", err)
		}
		code, err := gojq.Compile(q)
		if err != nil {
			return nil, cmdutil.Usagef("--jq: %v", err)
		}
		var out []any
		iter := code.Run(normaliseForJQ(v))
		for {
			r, ok := iter.Next()
			if !ok {
				break
			}
			if e, isErr := r.(error); isErr {
				if _, halt := e.(*gojq.HaltError); halt {
					break
				}
				return nil, cmdutil.Usagef("--jq: %v", e)
			}
			out = append(out, r)
		}
		return out, nil
	}
	r, err := jmespath.Search(query, v)
	if err != nil {
		return nil, cmdutil.Usagef("--query: %v", err)
	}
	return []any{r}, nil
}

// MatchJQ reports whether a jq expression is truthy for v (events tail --until-match).
func MatchJQ(v any, expr string) (bool, error) {
	rs, err := Apply(v, expr, "")
	if err != nil {
		return false, err
	}
	for _, r := range rs {
		if r != nil && r != false {
			return true, nil
		}
	}
	return false, nil
}

func (p *Printer) writeResult(r any) error {
	if s, ok := r.(string); ok {
		_, err := fmt.Fprintln(p.out(), s)
		return err
	}
	var b []byte
	var err error
	if p.F.IO.IsStdoutTTY() && p.Format != JSONL {
		b, err = json.MarshalIndent(r, "", "  ")
	} else {
		b, err = json.Marshal(r)
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(p.out(), "%s\n", b)
	return err
}

func decode(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, fmt.Errorf("the response is not JSON: %w", err)
	}
	return v, nil
}

// Decode reads JSON keeping numbers exact.
func Decode(raw []byte) (any, error) { return decode(raw) }

// normaliseForJQ converts json.Number, which gojq does not accept, to int or float64.
func normaliseForJQ(v any) any {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return int(i)
		}
		f, _ := t.Float64()
		return f
	case map[string]any:
		for k, x := range t {
			t[k] = normaliseForJQ(x)
		}
		return t
	case []any:
		for i, x := range t {
			t[i] = normaliseForJQ(x)
		}
		return t
	}
	return v
}
