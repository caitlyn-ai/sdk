package root

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/go/core"
)

// DescribeOperation prints an operation's input and output as JSON Schema (api --describe). The describe package
// sets it.
var DescribeOperation = func(f *cmdutil.Factory, op *spec.Operation) error {
	b, _ := json.MarshalIndent(op, "", "  ")
	_, err := fmt.Fprintf(f.IO.Out, "%s\n", b)
	return err
}

// apiArgs is what `caitlyn api` was given.
type apiArgs struct {
	positional []string
	fields     []string // --field key=value (typed)
	raw        []string // --raw-field key=value (always text)
	headers    []string
	input      string
	include    bool
	paginate   bool
	describe   bool
	members    map[string]string
	order      []string
	ifMatch    *string
	idemKey    string
}

func newAPICommand(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "api <Operation> [--member value …] | api <METHOD> <path>",
		Short: "Call any operation by name, or any path, including ones newer than this CLI",
		Long: `Calls any Caitlyn operation by its name, or any path by method and path (the CLI design, 2.6).

By operation name, the input is checked against the model this CLI was built from: give members as flags
(--knowledge-base-id, or the identifier's short flag such as --kb), with --field key=value, or the whole input
with --input file.json (- for stdin). Retries, idempotency keys, If-Match, the release check and typed errors
all apply.

By method and path, nothing is checked, which reaches an operation newer than the CLI. --field key=value (numbers
and booleans parsed, @file reads a file, json: parses JSON) and --raw-field key=value (always text) build the
query (GET, DELETE) or the JSON body (otherwise). --paginate follows nextCursor.

--include prints the status line and response headers first. --describe prints an operation's input and output
as JSON Schema.`,
		Example: `  caitlyn api GetDocument --kb KB4T7YQ2WL --document 0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47
  caitlyn api GET /v3/knowledge-bases/KB4T7YQ2WL/documents --field limit=5 --paginate
  caitlyn api ListDocuments --describe`,
		DisableFlagParsing: true,
		SilenceUsage:       true,
		RunE: func(cmd *cobra.Command, args []string) error {
			a, err := parseAPIArgs(f, args)
			if err != nil {
				return err
			}
			if a == nil {
				return cmd.Help()
			}
			if err := prepare(f, cmd); err != nil {
				return err
			}
			return runAPI(cmd.Context(), f, a)
		},
	}
	return cmd
}

// parseAPIArgs reads the arguments by hand, because an operation's members are only known once its name is: the
// global flags are taken out, and every other --flag value is a member.
func parseAPIArgs(f *cmdutil.Factory, args []string) (*apiArgs, error) {
	a := &apiArgs{members: map[string]string{}}
	g := f.Globals
	take := func(i *int, name string) (string, error) {
		if j := strings.IndexByte(args[*i], '='); j >= 0 {
			return args[*i][j+1:], nil
		}
		if *i+1 >= len(args) {
			return "", cmdutil.Usagef("%s needs a value", name)
		}
		*i++
		return args[*i], nil
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			a.positional = append(a.positional, arg)
			continue
		}
		name := strings.TrimLeft(arg, "-")
		if j := strings.IndexByte(name, '='); j >= 0 {
			name = name[:j]
		}
		var err error
		var v string
		switch name {
		case "h", "help":
			return nil, nil
		case "o", "output":
			g.Output, err = take(&i, "--output")
		case "query":
			g.Query, err = take(&i, "--query")
		case "jq":
			g.JQ, err = take(&i, "--jq")
		case "profile":
			g.Profile, err = take(&i, "--profile")
		case "workspace":
			g.Workspace, err = take(&i, "--workspace")
		case "color":
			g.Color, err = take(&i, "--color")
		case "no-color":
			g.NoColor = true
		case "no-input":
			g.NoInput = true
		case "no-pager":
			g.NoPager = true
		case "y", "yes":
			g.Yes = true
		case "confirm":
			g.Confirm, err = take(&i, "--confirm")
		case "debug":
			g.Debug = "requests"
			if strings.Contains(arg, "=") {
				g.Debug, _ = take(&i, "--debug")
			}
		case "dry-run":
			g.DryRun = "request"
			if strings.Contains(arg, "=") {
				g.DryRun, _ = take(&i, "--dry-run")
			}
		case "F", "field":
			v, err = take(&i, "--field")
			a.fields = append(a.fields, v)
		case "f", "raw-field":
			v, err = take(&i, "--raw-field")
			a.raw = append(a.raw, v)
		case "H", "header":
			v, err = take(&i, "--header")
			a.headers = append(a.headers, v)
		case "input":
			a.input, err = take(&i, "--input")
		case "i", "include":
			a.include = true
		case "paginate":
			a.paginate = true
		case "describe":
			a.describe = true
		case "if-match":
			v, err = take(&i, "--if-match")
			a.ifMatch = &v
		case "idempotency-key":
			a.idemKey, err = take(&i, "--idempotency-key")
		default:
			v, err = take(&i, "--"+name)
			if _, ok := a.members[name]; !ok {
				a.order = append(a.order, name)
			}
			a.members[name] = v
		}
		if err != nil {
			return nil, err
		}
	}
	if len(a.positional) == 0 {
		return nil, nil
	}
	return a, nil
}

func isMethod(s string) bool {
	switch s {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD":
		return true
	}
	return false
}

func runAPI(ctx context.Context, f *cmdutil.Factory, a *apiArgs) error {
	m := f.Manifest()
	if isMethod(a.positional[0]) {
		if len(a.positional) != 2 || !strings.HasPrefix(a.positional[1], "/") {
			return cmdutil.Usagef("give a method and a path: caitlyn api GET /v3/knowledge-bases")
		}
		return apiPath(ctx, f, a, a.positional[0], a.positional[1])
	}
	if len(a.positional) > 1 {
		return cmdutil.Usagef("caitlyn api takes one operation name; give members as flags (--name value)")
	}
	op := m.Op(a.positional[0])
	if op == nil {
		e := cmdutil.Usagef("%s is not an operation this CLI knows.", a.positional[0])
		e.Detail = "It may be newer than this CLI: call it by method and path instead, or update the CLI."
		e.AddNext("caitlyn api GET /v3/…", "call it by method and path")
		var near []string
		for _, n := range m.OperationNames() {
			if strings.Contains(strings.ToLower(n), strings.ToLower(a.positional[0])) {
				near = append(near, n)
			}
		}
		if len(near) > 0 {
			e.Detail += " Similar: " + strings.Join(near, ", ") + "."
		}
		return e
	}
	if a.describe {
		return DescribeOperation(f, op)
	}
	in, err := apiInput(f, op, a)
	if err != nil {
		return err
	}
	// The same checks a generated command makes: read-only, agent scopes, --yes and --confirm (18.5)
	action := gen.Action{Name: "caitlyn api " + op.Name, Title: op.Title, Impact: gen.ImpactOf(f, op), Scopes: gen.ScopesOf(m, op.Name)}
	if id, ok := f.Overlay().Confirm[op.Name]; ok {
		if v, ok := in.Values[id].(string); ok {
			action.Targets = []string{v}
		}
	}
	if err := gen.Allowed(f, action); err != nil {
		return err
	}
	if err := gen.Confirmed(f, action); err != nil {
		return err
	}
	if f.Globals.DryRun != "" {
		return gen.DryRun(f, op, in)
	}
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return err
	}
	u := gen.UIFor(f)
	p, err := output.New(f, u)
	if err != nil {
		return err
	}
	if p.Format == output.Table {
		p.Format, p.Human = output.JSON, false
	}
	if op.SSE != nil {
		s, err := invoke.Open(ctx, cc, m, op, in)
		if err != nil {
			return err
		}
		defer s.Close()
		for ev, err := range s.Events() {
			if err != nil {
				return err
			}
			if err := p.Event(ev.Type, ev.ID, ev.Data); err != nil {
				return err
			}
		}
		return nil
	}
	if op.Paginated != nil && a.paginate {
		return p.List(ctx, func(ctx context.Context, cur string) (*output.Page, error) {
			pin := invoke.NewInput()
			for _, k := range in.Order {
				pin.Set(k, in.Values[k])
			}
			if cur != "" {
				pin.Set(op.Paginated.InputToken, cur)
			}
			res, err := invoke.Call(ctx, cc, op, pin)
			if err != nil {
				return nil, err
			}
			return pageOf(res.Body, op.Paginated.Items, op.Paginated.OutputToken), nil
		}, output.ListOptions{All: true})
	}
	res, err := invoke.Call(ctx, cc, op, in)
	if err != nil {
		return err
	}
	if a.include {
		printHeaders(f, res.Status, res.Header)
	}
	body := res.Thing(op)
	if len(body) == 0 {
		return nil
	}
	if err := gen.ClearSecrets(f, op, body); err != nil {
		return err
	}
	return p.Raw(body, "")
}

func pageOf(body []byte, itemsKey, nextKey string) *output.Page {
	raw := map[string]json.RawMessage{}
	_ = json.Unmarshal(body, &raw)
	var items []json.RawMessage
	_ = json.Unmarshal(raw[itemsKey], &items)
	next := ""
	_ = json.Unmarshal(raw[nextKey], &next)
	return &output.Page{Raw: body, Items: items, Next: next}
}

func printHeaders(f *cmdutil.Factory, status int, h http.Header) {
	fmt.Fprintf(f.IO.Out, "HTTP %d %s\n", status, http.StatusText(status))
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, v := range h[k] {
			fmt.Fprintf(f.IO.Out, "%s: %s\n", k, cmdutil.RedactHeader(k, v))
		}
	}
	fmt.Fprintln(f.IO.Out)
}

// apiInput builds an operation's input from --input, then --field and --raw-field, then member flags. A member flag
// may be the member's name in kebab-case (--knowledge-base-id), its wire name, or an identifier's flag (--kb).
func apiInput(f *cmdutil.Factory, op *spec.Operation, a *apiArgs) (*invoke.Input, error) {
	in := invoke.NewInput()
	if a.input != "" {
		var b []byte
		var err error
		if a.input == "-" {
			b, err = io.ReadAll(f.IO.In)
		} else {
			b, err = os.ReadFile(a.input)
		}
		if err != nil {
			return nil, cmdutil.Usagef("%s could not be read: %v", a.input, err)
		}
		j, err := output.YAMLToJSON(b)
		if err != nil {
			return nil, cmdutil.Usagef("%s is not JSON or YAML: %v", a.input, err)
		}
		v, err := output.Decode(j)
		if err != nil {
			return nil, err
		}
		obj, ok := v.(map[string]any)
		if !ok {
			return nil, cmdutil.Usagef("%s must hold an object of members", a.input)
		}
		for _, mem := range op.Input {
			for _, k := range []string{mem.Name, mem.Wire} {
				if val, ok := obj[k]; ok {
					in.Set(mem.Name, val)
				}
			}
		}
	}
	o := f.Overlay()
	byFlag := map[string]*spec.Member{}
	for _, mem := range op.Input {
		byFlag[spec.Kebab(mem.Name)] = mem
		byFlag[mem.Name] = mem
		byFlag[mem.Wire] = mem
		n := o.Name(mem.Name)
		if mem.Location == "label" {
			byFlag[n.Flag] = mem
			for _, al := range n.Aliases {
				byFlag[al] = mem
			}
		}
	}
	set := func(kv string, typed bool) error {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			return cmdutil.Usagef("write a field as key=value: %q", kv)
		}
		k, v := kv[:eq], kv[eq+1:]
		mem := byFlag[k]
		if mem == nil {
			return cmdutil.Usagef("%s has no member %q", op.Name, k)
		}
		if !typed {
			in.Set(mem.Name, v)
			return nil
		}
		val, err := typedValue(mem, v)
		if err != nil {
			return err
		}
		in.Set(mem.Name, val)
		return nil
	}
	for _, kv := range a.fields {
		if err := set(kv, true); err != nil {
			return nil, err
		}
	}
	for _, kv := range a.raw {
		if err := set(kv, false); err != nil {
			return nil, err
		}
	}
	for _, name := range a.order {
		if err := set(name+"="+a.members[name], true); err != nil {
			return nil, err
		}
	}
	in.IfMatch = a.ifMatch
	in.IdempotencyKey = a.idemKey
	for _, h := range a.headers {
		if i := strings.IndexByte(h, ':'); i > 0 {
			in.Header.Add(strings.TrimSpace(h[:i]), strings.TrimSpace(h[i+1:]))
		}
	}
	return in, nil
}

// typedValue reads a value for a member: @file, json:…, then by the member's type.
func typedValue(mem *spec.Member, v string) (any, error) {
	switch {
	case strings.HasPrefix(v, "@"):
		b, err := os.ReadFile(v[1:])
		if err != nil {
			return nil, cmdutil.Usagef("%s could not be read: %v", v[1:], err)
		}
		return string(b), nil
	case strings.HasPrefix(v, "json:"):
		return output.Decode([]byte(v[5:]))
	}
	return guess(v, mem), nil
}

// guess types a --field value: numbers and booleans parsed (as gh does), unless the member is text.
func guess(v string, mem *spec.Member) any {
	if mem != nil && (mem.Type.Type == "string" || mem.Type.Type == "enum" || mem.Type.Type == "timestamp") {
		return v
	}
	switch v {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	if n := json.Number(v); isNumber(v) {
		return n
	}
	if mem != nil && mem.Type.Type == "list" {
		var items []any
		for _, p := range strings.Split(v, ",") {
			items = append(items, strings.TrimSpace(p))
		}
		return items
	}
	return v
}

func isNumber(s string) bool {
	var f float64
	_, err := fmt.Sscanf(s, "%g", &f)
	return err == nil && strings.TrimLeft(s, "-0123456789.eE+") == ""
}

// apiPath calls a path directly (2.6): nothing is checked against the model.
func apiPath(ctx context.Context, f *cmdutil.Factory, a *apiArgs, method, path string) error {
	query := map[string][]string{}
	body := map[string]any{}
	var order []string
	add := func(kv string, typed bool) error {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			return cmdutil.Usagef("write a field as key=value: %q", kv)
		}
		k, v := kv[:eq], kv[eq+1:]
		var val any = v
		if typed {
			var err error
			if val, err = typedValue(nil, v); err != nil {
				return err
			}
		}
		if method == "GET" || method == "DELETE" || method == "HEAD" {
			query[k] = append(query[k], fmt.Sprint(val))
			return nil
		}
		if _, ok := body[k]; !ok {
			order = append(order, k)
		}
		body[k] = val
		return nil
	}
	for _, kv := range a.fields {
		if err := add(kv, true); err != nil {
			return err
		}
	}
	for _, kv := range a.raw {
		if err := add(kv, false); err != nil {
			return err
		}
	}
	for _, name := range a.order {
		if err := add(name+"="+a.members[name], true); err != nil {
			return err
		}
	}
	var payload []byte
	if a.input != "" {
		var err error
		if a.input == "-" {
			payload, err = io.ReadAll(f.IO.In)
		} else {
			payload, err = os.ReadFile(a.input)
		}
		if err != nil {
			return cmdutil.Usagef("%s could not be read: %v", a.input, err)
		}
		if j, err := output.YAMLToJSON(payload); err == nil {
			payload = j
		}
	} else if len(body) > 0 {
		var buf bytes.Buffer
		buf.WriteByte('{')
		for i, k := range order {
			if i > 0 {
				buf.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			vb, _ := json.Marshal(body[k])
			buf.Write(kb)
			buf.WriteByte(':')
			buf.Write(vb)
		}
		buf.WriteByte('}')
		payload = buf.Bytes()
	}
	// By method and path nothing says what the path needs: anything but a read is a write (DELETE is destructive),
	// refused on a read-only profile, and under an AI agent allowed only with agent scopes of full (18.5)
	impact := "write"
	switch method {
	case "GET", "HEAD":
		impact = "read"
	case "DELETE":
		impact = "destructive"
	}
	action := gen.Action{Name: "caitlyn api " + method + " " + path, Impact: impact, UnknownScopes: true}
	if err := gen.Allowed(f, action); err != nil {
		return err
	}
	if err := gen.Confirmed(f, action); err != nil {
		return err
	}
	retrySafe := method == "GET" || method == "HEAD" || method == "PUT" || method == "DELETE" || a.idemKey != ""
	op := &core.Operation{Name: "api", Method: method, RetrySafe: retrySafe, Errors: func(_ int, e *core.APIError) error { return e }, Retryable: []int{429, 503}}
	build := func(cursor string) *core.Request {
		req := core.NewRequest(path)
		for k, vs := range query {
			for _, v := range vs {
				req.Query.Add(k, v)
			}
		}
		if cursor != "" {
			req.Query.Set("cursor", cursor)
		}
		for _, h := range a.headers {
			if i := strings.IndexByte(h, ':'); i > 0 {
				req.Header.Add(strings.TrimSpace(h[:i]), strings.TrimSpace(h[i+1:]))
			}
		}
		if payload != nil {
			req.Body, req.ContentType = payload, "application/json"
		}
		return req
	}
	var opts []core.CallOption
	if a.ifMatch != nil {
		opts = append(opts, core.WithIfMatch(*a.ifMatch))
	}
	if a.idemKey != "" {
		op.IdempotencyHeader = "Idempotency-Key"
		opts = append(opts, core.WithIdempotencyKey(a.idemKey))
	}
	if f.Globals.DryRun != "" {
		req := build("")
		fmt.Fprintf(f.IO.Out, "%s %s", method, path)
		if q := req.Query.Encode(); q != "" {
			fmt.Fprintf(f.IO.Out, "?%s", q)
		}
		fmt.Fprintln(f.IO.Out)
		if len(req.Body) > 0 {
			fmt.Fprintf(f.IO.Out, "\n%s\n", req.Body)
		}
		fmt.Fprintln(f.IO.ErrOut, "Dry run: nothing was sent.")
		return nil
	}
	cc, _, err := f.Clients(ctx)
	if err != nil {
		return err
	}
	u := gen.UIFor(f)
	p, err := output.New(f, u)
	if err != nil {
		return err
	}
	if p.Format == output.Table {
		p.Format, p.Human = output.JSON, false
	}
	send := func(cursor string) (int, http.Header, []byte, error) {
		resp, err := cc.Do(ctx, op, build(cursor), opts)
		if err != nil {
			return 0, nil, nil, err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		return resp.StatusCode, resp.Header, b, err
	}
	if a.paginate {
		return p.List(ctx, func(ctx context.Context, cur string) (*output.Page, error) {
			_, _, b, err := send(cur)
			if err != nil {
				return nil, err
			}
			return pageOf(b, "items", "nextCursor"), nil
		}, output.ListOptions{All: true})
	}
	status, header, b, err := send("")
	if err != nil {
		return err
	}
	if a.include {
		printHeaders(f, status, header)
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return nil
	}
	if !json.Valid(b) {
		_, err := f.IO.Out.Write(b)
		return err
	}
	return p.Raw(b, "")
}
