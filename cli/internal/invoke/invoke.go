// Package invoke sends one modelled operation from an input the CLI assembled (flags, files, stdin), through the
// Go SDK's runtime (core.Client.Do), so retries, idempotency keys, If-Match, the @since check, sign-in and typed
// errors are the SDK's own. The response body comes back as the server sent it: the CLI prints the server's JSON,
// unknown fields included.
package invoke

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/go/core"
)

// Input is an operation's input: member name to value (strings, numbers, booleans, lists and objects, as JSON
// would hold them). Order keeps the order members were given in, for a body that reads naturally.
type Input struct {
	Values map[string]any
	Order  []string
	// IfMatch and IdempotencyKey are call options, not members.
	IfMatch        *string
	IdempotencyKey string
	// Header adds request headers (Last-Event-ID on a watch).
	Header http.Header
}

// NewInput returns an empty input.
func NewInput() *Input { return &Input{Values: map[string]any{}, Header: http.Header{}} }

// Set sets a member.
func (in *Input) Set(member string, v any) {
	if _, ok := in.Values[member]; !ok {
		in.Order = append(in.Order, member)
	}
	in.Values[member] = v
}

// Has reports whether a member is set.
func (in *Input) Has(member string) bool { _, ok := in.Values[member]; return ok }

// Operation is the runtime's description of op.
func Operation(op *spec.Operation) *core.Operation {
	o := &core.Operation{
		Name:      op.Name,
		Method:    op.Method,
		Since:     op.Since,
		RetrySafe: op.RetrySafe,
		SSE:       op.SSE != nil,
		Errors:    func(_ int, e *core.APIError) error { return e },
		Retryable: []int{429, 503},
	}
	if op.IdempotencyHd != "" {
		o.IdempotencyHeader = op.IdempotencyHd
	}
	if op.IfMatch != nil && op.IfMatch.Required {
		o.IfMatchRequired = true
	}
	if op.Code >= 300 && op.Code < 400 {
		o.Redirect = op.Code
	}
	return o
}

// Build makes the HTTP request for op from in: labels into the path, query members into the query string,
// header members into headers, and body members (or the payload member) into the body.
func Build(op *spec.Operation, in *Input) (*core.Request, error) {
	path, err := expand(op, in)
	if err != nil {
		return nil, err
	}
	req := core.NewRequest(path)
	var set []core.Since
	body := map[string]any{}
	var bodyOrder []string
	var payload any
	hasPayload := false
	for _, m := range op.Input {
		v, ok := in.Values[m.Name]
		if !ok {
			if m.Required && m.Location != "label" && !m.Idempotency && !(op.IfMatch != nil && m.Name == op.IfMatch.Member) {
				return nil, core.MissingInput(op.Name, m.Name)
			}
			continue
		}
		if m.Since != "" {
			set = append(set, core.Since{Member: m.Name, Version: m.Since})
		}
		switch m.Location {
		case "label":
		case "query":
			for _, s := range queryValues(v) {
				req.Query.Add(m.Wire, s)
			}
		case "header":
			if op.IfMatch != nil && m.Name == op.IfMatch.Member {
				continue
			}
			if m.Idempotency {
				continue
			}
			req.Header.Set(m.Wire, scalarString(v))
		case "payload":
			payload, hasPayload = v, true
		default:
			body[m.Wire] = v
			bodyOrder = append(bodyOrder, m.Wire)
		}
	}
	for k, vs := range in.Header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Set = set
	switch {
	case hasPayload:
		switch p := payload.(type) {
		case []byte:
			req.Body = p
			req.ContentType = "application/octet-stream"
		case json.RawMessage:
			req.Body, req.ContentType = p, "application/json"
		default:
			b, err := json.Marshal(p)
			if err != nil {
				return nil, err
			}
			req.Body, req.ContentType = b, "application/json"
		}
	case len(body) > 0:
		b, err := marshalOrdered(body, orderBy(bodyOrder, in.Order, op))
		if err != nil {
			return nil, err
		}
		req.Body, req.ContentType = b, "application/json"
	case op.Method == http.MethodPost || op.Method == http.MethodPut || op.Method == http.MethodPatch:
		if hasBodyMembers(op) {
			req.Body, req.ContentType = []byte("{}"), "application/json"
		}
	}
	return req, nil
}

func hasBodyMembers(op *spec.Operation) bool {
	for _, m := range op.Input {
		if m.Location == "body" {
			return true
		}
	}
	return false
}

// orderBy orders body members as the caller gave them, then the rest in model order.
func orderBy(wire []string, given []string, op *spec.Operation) []string {
	pos := map[string]int{}
	for i, name := range given {
		if m := op.Member(name); m != nil {
			pos[m.Wire] = i
		}
	}
	out := append([]string(nil), wire...)
	sort.SliceStable(out, func(i, j int) bool {
		pi, oki := pos[out[i]]
		pj, okj := pos[out[j]]
		switch {
		case oki && okj:
			return pi < pj
		case oki:
			return true
		}
		return false
	})
	return out
}

func marshalOrdered(m map[string]any, order []string) ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range order {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		b.Write(kb)
		b.WriteByte(':')
		vb, err := json.Marshal(m[k])
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// expand fills the URI's labels. A greedy label ({path+}) keeps its slashes; any other is one escaped segment.
func expand(op *spec.Operation, in *Input) (string, error) {
	uri := op.URI
	q := ""
	if i := strings.IndexByte(uri, '?'); i >= 0 {
		uri, q = uri[:i], uri[i:]
	}
	var b strings.Builder
	for {
		i := strings.IndexByte(uri, '{')
		if i < 0 {
			b.WriteString(uri)
			break
		}
		j := strings.IndexByte(uri[i:], '}')
		if j < 0 {
			return "", fmt.Errorf("%s: malformed URI %s", op.Name, op.URI)
		}
		b.WriteString(uri[:i])
		label := uri[i+1 : i+j]
		greedy := strings.HasSuffix(label, "+")
		label = strings.TrimSuffix(label, "+")
		member := label
		for _, m := range op.Input {
			if m.Location == "label" && m.Wire == label {
				member = m.Name
			}
		}
		v, ok := in.Values[member]
		s := scalarString(v)
		if !ok || s == "" {
			return "", core.MissingInput(op.Name, member)
		}
		if greedy {
			parts := strings.Split(s, "/")
			for k, p := range parts {
				parts[k] = url.PathEscape(p)
			}
			b.WriteString(strings.Join(parts, "/"))
		} else {
			b.WriteString(url.PathEscape(s))
		}
		uri = uri[i+j+1:]
	}
	if q != "" {
		// A literal query in the URI (/v3/agents/{agentId}:compare?x=y): keep it
		b.WriteString(q)
	}
	return b.String(), nil
}

func scalarString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func queryValues(v any) []string {
	if l, ok := v.([]any); ok {
		out := make([]string, 0, len(l))
		for _, x := range l {
			out = append(out, scalarString(x))
		}
		return out
	}
	if l, ok := v.([]string); ok {
		return l
	}
	return []string{scalarString(v)}
}

// Options are the call options for in.
func (in *Input) Options() []core.CallOption {
	var opts []core.CallOption
	if in.IfMatch != nil {
		opts = append(opts, core.WithIfMatch(*in.IfMatch))
	}
	if in.IdempotencyKey != "" {
		opts = append(opts, core.WithIdempotencyKey(in.IdempotencyKey))
	}
	return opts
}

// Result is a response: its status, headers and body as received.
type Result struct {
	Status int
	Header http.Header
	Body   []byte
}

// Metadata is the response's request ID and API version.
func (r *Result) Metadata() core.ResponseMetadata {
	return core.ResponseMetadata{HTTPStatusCode: r.Status, RequestID: r.Header.Get("Caitlyn-Request-Id"), APIVersion: r.Header.Get("Caitlyn-Api-Version")}
}

// Call sends op and reads the whole response.
func Call(ctx context.Context, c *core.Client, op *spec.Operation, in *Input) (*Result, error) {
	req, err := Build(op, in)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(ctx, Operation(op), req, in.Options())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return &Result{Status: resp.StatusCode, Header: resp.Header, Body: b}, nil
}

// Thing returns the response's thing: the payload member's JSON when the output has one (the body is the thing), else
// the body. A body-less response (204) is described from its headers: {"etag": …, "location": …}.
func (r *Result) Thing(op *spec.Operation) []byte {
	if len(bytes.TrimSpace(r.Body)) > 0 {
		return r.Body
	}
	out := map[string]any{}
	order := []string{}
	for _, m := range op.Output {
		if m.Location == "header" && m.Name != "requestId" && m.Name != "apiVersion" {
			if v := r.Header.Get(m.Wire); v != "" {
				out[m.Name] = v
				order = append(order, m.Name)
			}
		}
	}
	if r.Status >= 300 && r.Status < 400 {
		if v := r.Header.Get("Location"); v != "" && out["location"] == nil {
			out["location"] = v
			order = append(order, "location")
		}
	}
	if len(order) == 0 {
		return nil
	}
	b, _ := marshalOrdered(out, order)
	return b
}
