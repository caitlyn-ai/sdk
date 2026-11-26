package gen

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/go/core"
)

// DryRun prints the request a command would send, and sends nothing (3.5): method, URL, headers with
// Authorization redacted, and the body. --dry-run=curl prints it as a curl command using $CAITLYN_TOKEN.
func DryRun(f *cmdutil.Factory, op *spec.Operation, in *invoke.Input) error {
	req, err := invoke.Build(op, in)
	if err != nil {
		return err
	}
	ws, _ := f.Workspace()
	endpoint := ""
	if cfg, err := f.Config(); err == nil {
		endpoint = cfg.String("endpoint")
	}
	if endpoint == "" {
		if ws == "" {
			ws = "<workspace>"
		}
		endpoint = core.WorkspaceEndpoint(ws)
	}
	u := strings.TrimRight(endpoint, "/") + req.Path
	if q := req.Query.Encode(); q != "" {
		u += "?" + q
	}
	headers := map[string]string{}
	for k, vs := range req.Header {
		headers[k] = strings.Join(vs, ", ")
	}
	if req.ContentType != "" {
		headers["Content-Type"] = req.ContentType
	}
	if in.IfMatch != nil {
		headers["If-Match"] = *in.IfMatch
	}
	if op.IdempotencyHd != "" {
		key := in.IdempotencyKey
		if key == "" {
			key = "<a new key per run>"
		}
		headers[op.IdempotencyHd] = key
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	w := f.IO.Out
	if f.Globals.DryRun == "curl" {
		fmt.Fprintf(w, "curl -X %s %s \\\n  -H \"Authorization: Bearer $CAITLYN_TOKEN\"", op.Method, shellQuote(u))
		for _, k := range names {
			fmt.Fprintf(w, " \\\n  -H %s", shellQuote(k+": "+headers[k]))
		}
		if len(req.Body) > 0 {
			fmt.Fprintf(w, " \\\n  --data %s", shellQuote(string(req.Body)))
		}
		fmt.Fprintln(w)
		return nil
	}
	fmt.Fprintf(w, "%s %s\n", op.Method, u)
	fmt.Fprintln(w, "Authorization: Bearer [redacted]")
	for _, k := range names {
		fmt.Fprintf(w, "%s: %s\n", k, headers[k])
	}
	if len(req.Body) > 0 {
		fmt.Fprintf(w, "\n%s\n", req.Body)
	}
	fmt.Fprintln(f.IO.ErrOut, "Dry run: nothing was sent.")
	return nil
}

// Skeleton prints a commented YAML input with every member and its documentation (--generate-input, after the AWS
// CLI's --generate-cli-skeleton).
func Skeleton(w io.Writer, m *spec.Manifest, op *spec.Operation, in *invoke.Input) error {
	fmt.Fprintf(w, "# Input for %s. Fill in what you need, remove the rest, then:\n#   caitlyn … --from-file this.yaml\n", op.Name)
	for _, mem := range op.Input {
		if mem.Location == "label" || mem.Idempotency || (op.IfMatch != nil && mem.Name == op.IfMatch.Member) {
			continue
		}
		skeletonMember(w, m, mem, 0, map[string]bool{})
	}
	return nil
}

func skeletonMember(w io.Writer, m *spec.Manifest, mem *spec.Member, depth int, seen map[string]bool) {
	indent := strings.Repeat("  ", depth)
	if doc := firstSentence(mem.Documentation); doc != "" {
		fmt.Fprintf(w, "%s# %s", indent, doc)
		if mem.Required {
			fmt.Fprint(w, " Required.")
		}
		fmt.Fprintln(w)
	}
	t := mem.Type
	switch t.Type {
	case "ref":
		fmt.Fprintf(w, "%s%s:\n", indent, mem.Wire)
		if seen[t.Ref] || depth > 3 {
			fmt.Fprintf(w, "%s  # (%s)\n", indent, t.Ref)
			return
		}
		seen[t.Ref] = true
		if sh := m.Shapes[t.Ref]; sh != nil {
			for _, sm := range sh.Members {
				skeletonMember(w, m, sm, depth+1, seen)
			}
		}
		delete(seen, t.Ref)
	case "list":
		fmt.Fprintf(w, "%s%s: []\n", indent, mem.Wire)
	case "map", "document":
		fmt.Fprintf(w, "%s%s: {}\n", indent, mem.Wire)
	case "enum":
		fmt.Fprintf(w, "%s%s: \"\"  # %s\n", indent, mem.Wire, strings.Join(t.Enum(), " | "))
	case "boolean":
		fmt.Fprintf(w, "%s%s: false\n", indent, mem.Wire)
	case "integer", "number":
		fmt.Fprintf(w, "%s%s: 0\n", indent, mem.Wire)
	default:
		fmt.Fprintf(w, "%s%s: \"\"\n", indent, mem.Wire)
	}
}
