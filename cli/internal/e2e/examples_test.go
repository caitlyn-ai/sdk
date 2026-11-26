package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

type exampleCase struct {
	ID        string          `json:"id"`
	Operation string          `json:"operation"`
	Input     json.RawMessage `json:"input"`
	Response  struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	} `json:"response"`
	Expected struct {
		Error *struct {
			Status int    `json:"status"`
			Code   string `json:"code"`
		} `json:"error"`
	} `json:"expected"`
}

// registry builds the command tree once, to turn each example into a command line.
func registry(t *testing.T) *gen.Registry {
	t.Helper()
	io, _, _ := iostreams.Test("")
	u := ui.New(io)
	f := &cmdutil.Factory{IO: io, Globals: &cmdutil.Globals{}, Version: "test"}
	if _, err := root.New(f, &u); err != nil {
		t.Fatal(err)
	}
	return gen.Current
}

// pick chooses the command an example's input means: the one whose fixed members (agent.draft's version) match it,
// else one with no fixed members.
func pick(cmds []*gen.Command, input map[string]any) *gen.Command {
	var plain *gen.Command
	for _, c := range cmds {
		if c.Spec.Hidden && len(cmds) > 1 {
			continue
		}
		if len(c.Spec.Fixed) == 0 {
			if plain == nil {
				plain = c
			}
			continue
		}
		match := true
		for k, v := range c.Spec.Fixed {
			if input[k] != v {
				match = false
			}
		}
		if match {
			return c
		}
	}
	if plain == nil && len(cmds) > 0 {
		return cmds[0]
	}
	return plain
}

// TestExamplesAsCommands is the CLI's share of the conformance suite (17.2): every @examples entry, turned into its
// command line, runs against the mock, which checks the request (method, path, query, headers, body); the exit
// code must be the example's.
func TestExamplesAsCommands(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot, "conformance", "cases", "examples.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []exampleCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	reg := registry(t)
	m := spec.MustLoad()
	var skipped []string
	ran := 0
	for _, ex := range file.Cases {
		op := m.Op(ex.Operation)
		if op == nil {
			continue
		}
		var input map[string]any
		_ = json.Unmarshal(ex.Input, &input)
		c := pick(reg.ByOp[ex.Operation], input)
		estimate := false
		if c == nil && op.EstimateFor != "" {
			// an estimate has no command of its own: it's --estimate on the job's command (3.5)
			for _, jc := range reg.ByOp[op.EstimateFor] {
				if jc.Spec.Estimate == ex.Operation {
					c, estimate = jc, true
				}
			}
		}
		hooked := c != nil && (c.Spec.Name() == "knowledge-bases documents create" || c.Spec.Name() == "knowledge-bases documents replace")
		if c == nil || hooked {
			// upload commands send a file through the SDK's own upload, which the SDK suites cover
			skipped = append(skipped, ex.ID)
			continue
		}
		var se *spec.Example
		for _, e := range op.Examples {
			if strings.HasSuffix(ex.ID, ": "+e.Title) {
				se = e
			}
		}
		if se == nil {
			se = &spec.Example{Title: ex.ID, Input: ex.Input}
		}
		args, ok := c.ExampleArgs(se, true)
		if estimate {
			args = append(args, "--estimate")
		}
		if op.SSE != nil {
			args = append(args, "--until-match", "true", "--timeout", "20s")
		}
		if !ok {
			skipped = append(skipped, ex.ID)
			continue
		}
		ran++
		t.Run(ex.ID, func(t *testing.T) {
			reset(t)
			post(t, "/__mock/example", map[string]string{"id": ex.ID})
			r := run(t, nil, "", append(args, "-o", "json", "--yes")...)
			var res struct {
				Served     bool     `json:"served"`
				Mismatches []string `json:"mismatches"`
			}
			getJSON(t, "/__mock/example", &res)
			if !res.Served || len(res.Mismatches) > 0 {
				t.Fatalf("caitlyn %s\nserved %v, the request differs from the example: %v\nstderr: %s", strings.Join(args, " "), res.Served, res.Mismatches, r.errOut)
			}
			want := exitcode.OK
			if e := ex.Expected.Error; e != nil {
				want = exitcode.ForStatus(e.Status)
				if c, ok := exitcode.ForCode(e.Code); ok {
					want = c
				}
				if !strings.Contains(r.errOut, `"code":"`+e.Code+`"`) {
					t.Errorf("stderr should carry the problem's code %s:\n%s", e.Code, r.errOut)
				}
				// every error carries a hint an agent can act on, with a command to run (18.2)
				if !strings.Contains(r.errOut, `"next":[{"run":"caitlyn `) {
					t.Errorf("%s has no hint with a command to run:\n%s", e.Code, r.errOut)
				}
			}
			if r.code != want {
				t.Fatalf("caitlyn %s\nexit %d, want %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), r.code, want, r.out, r.errOut)
			}
		})
	}
	sort.Strings(skipped)
	t.Logf("%d example cases ran as commands; %d skipped (uploads, or no command line): %s", ran, len(skipped), strings.Join(skipped, "; "))
	if ran < len(file.Cases)/2 {
		t.Fatalf("only %d of %d example cases ran", ran, len(file.Cases))
	}
}
