package gen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/invoke"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	caitlyn "github.com/caitlyn-ai/sdk/go"
	"github.com/caitlyn-ai/sdk/go/core"
)

// AgentWaitDefault is --wait's time limit under an AI agent when none is given: agents' tool calls time out after a
// few minutes, so the CLI stops first and prints the command that resumes the wait (18.2).
const AgentWaitDefault = 4 * time.Minute

// Timeout is the wait's limit: --timeout, then wait_timeout in configuration, then 4 minutes under an AI agent.
// Zero means none. In CI a wait with no limit gets a warning (15.6).
func (r *Run) Timeout() (time.Duration, error) {
	s, _ := r.Cobra.Flags().GetString("timeout")
	if s == "" {
		if cfg, err := r.F.Config(); err == nil {
			s = cfg.String("wait_timeout")
		}
	}
	if s == "" {
		if r.F.Agent.On {
			return AgentWaitDefault, nil
		}
		if r.F.CI.In() {
			r.UI.Warnf("--wait has no --timeout: set one, so a stuck job fails this step instead of the runner's job timeout.")
		}
		return 0, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, cmdutil.Usagef("--timeout %q: write it as 90s, 30m or 1h", s)
	}
	return d, nil
}

// wait follows the thing the command acted on until nothing runs on it (6.1), through the SDK scope's wait(): a
// watch that starts with a snapshot. The thing is printed when it settles.
func (r *Run) wait(ctx context.Context, lr *spec.LongRunning, thing []byte) error {
	limit, err := r.Timeout()
	if err != nil {
		return err
	}
	_, tc, err := r.F.Clients(ctx)
	if err != nil {
		return err
	}
	ids := map[string]string{}
	for k, v := range r.IDs {
		ids[k] = v
	}
	// A create's new thing: its identifier is in the response (creates.source, output:document.id)
	if thing != nil {
		var obj map[string]any
		_ = json.Unmarshal(thing, &obj)
		switch lr.Filter {
		case "document":
			if ids["documentId"] == "" {
				ids["documentId"] = str(obj, "id")
			}
		case "folder":
			if ids["folderPath"] == "" {
				ids["folderPath"] = str(obj, "path")
			}
		case "batch":
			if ids["ingestionBatchId"] == "" {
				ids["ingestionBatchId"] = str(obj, "id")
			}
		}
		if lr.Watch == "WatchOperation" && ids["operationId"] == "" {
			ids["operationId"] = firstString(obj, "operationId", "id")
			if op, ok := obj["operation"].(map[string]any); ok && ids["operationId"] == "" {
				ids["operationId"] = str(op, "id")
			}
		}
	}
	resume := r.resumeLine(lr, ids)
	if r.F.Agent.On || !r.F.IO.IsStderrTTY() {
		if resume != "" && (r.F.Agent.On || r.wantsProgress()) {
			fmt.Fprintf(r.F.IO.ErrOut, "waiting; resume: %s\n", resume)
		}
	}
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	interrupted := make(chan os.Signal, 1)
	signal.Notify(interrupted, os.Interrupt)
	defer signal.Stop(interrupted)
	go func() {
		select {
		case <-interrupted:
			cancel()
		case <-wctx.Done():
		}
	}()
	var opts []core.WaitOption
	if limit > 0 {
		opts = append(opts, core.WithTimeLimit(limit))
	}
	stop := Spinner(r.F, r.UI, "Waiting for it to finish")
	raw, err := waitFor(wctx, tc, lr, ids, opts)
	stop()
	if err != nil {
		switch {
		case ctx.Err() == nil && wctx.Err() != nil:
			e := &cmdutil.Error{Exit: exitcode.Interrupted, Code: "INTERRUPTED", Title: "Stopped waiting. The work carries on."}
			if resume != "" {
				e.AddNext(resume, "follow it again")
			}
			return e
		case isTimeout(err):
			e := &cmdutil.Error{Exit: exitcode.Timeout, Code: "WAIT_TIMEOUT", Title: fmt.Sprintf("Stopped waiting after %s. The work carries on.", limit), Cause: err}
			if resume != "" {
				e.AddNext(resume+" --timeout 10m", "keep waiting")
			}
			return e
		}
		return err
	}
	p, err := output.New(r.F, r.UI)
	if err != nil {
		return err
	}
	if p.Human && r.F.IO.IsStderrTTY() {
		r.UI.Successf("Finished.")
	}
	if raw == nil {
		return nil
	}
	return p.Raw(raw, "")
}

func (r *Run) wantsProgress() bool {
	b, _ := r.Cobra.Flags().GetBool("progress")
	return b
}

func isTimeout(err error) bool {
	var api *core.APIError
	if errors.As(err, &api) && (api.Code == "WAIT_TIMEOUT" || api.Code == "TIMEOUT") {
		return true
	}
	return errors.Is(err, context.DeadlineExceeded)
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s := str(m, k); s != "" {
			return s
		}
	}
	return ""
}

// resumeLine is the `wait` command that picks the wait up again.
func (r *Run) resumeLine(lr *spec.LongRunning, ids map[string]string) string {
	kb := ids["knowledgeBaseId"]
	q := shellQuote
	switch {
	case lr.Watch == "WatchKnowledgeBase" && lr.Filter == "document" && ids["documentId"] != "":
		return fmt.Sprintf("caitlyn kb documents wait %s --kb %s", q(ids["documentId"]), q(kb))
	case lr.Watch == "WatchKnowledgeBase" && lr.Filter == "folder" && ids["folderPath"] != "":
		return fmt.Sprintf("caitlyn kb folders wait %s --kb %s", q(ids["folderPath"]), q(kb))
	case lr.Watch == "WatchKnowledgeBase" && lr.Filter == "batch" && ids["ingestionBatchId"] != "":
		return fmt.Sprintf("caitlyn kb ingestion batches wait %s --kb %s", q(ids["ingestionBatchId"]), q(kb))
	case lr.Watch == "WatchKnowledgeBase" && kb != "":
		return fmt.Sprintf("caitlyn kb wait %s", q(kb))
	case lr.Watch == "WatchOperation" && ids["operationId"] != "":
		return fmt.Sprintf("caitlyn core operations watch %s --kb %s", q(ids["operationId"]), q(kb))
	}
	return ""
}

// waitFor calls the SDK scope's Wait for a watch and filter, and returns the settled thing's JSON.
func waitFor(ctx context.Context, tc *caitlyn.Client, lr *spec.LongRunning, ids map[string]string, opts []core.WaitOption) ([]byte, error) {
	kbID := ids["knowledgeBaseId"]
	switch lr.Watch {
	case "WatchKnowledgeBase":
		kb := tc.KnowledgeBase(kbID)
		switch lr.Filter {
		case "document":
			v, err := kb.Document(ids["documentId"]).Wait(ctx, opts...)
			if err != nil || v == nil {
				return nil, err
			}
			return v.RawJSON(), nil
		case "folder":
			v, err := kb.Folder(ids["folderPath"]).Wait(ctx, opts...)
			if err != nil || v == nil {
				return nil, err
			}
			return v.RawJSON(), nil
		case "batch":
			v, err := kb.Ingestion.Batch(ids["ingestionBatchId"]).Wait(ctx, opts...)
			if err != nil || v == nil {
				return nil, err
			}
			return v.RawJSON(), nil
		default:
			v, err := kb.Wait(ctx, opts...)
			if err != nil || v == nil {
				return nil, err
			}
			return v.RawJSON(), nil
		}
	case "WatchOperation":
		wctx, cancel := core.WaitContext(ctx, opts)
		defer cancel()
		s, err := tc.Core.Operation(kbID, ids["operationId"]).Watch(wctx, &caitlyn.WatchOperationInput{})
		if err != nil {
			return nil, err
		}
		defer s.Close()
		v, err := s.FinalMessage()
		if err != nil {
			if wctx.Err() != nil && ctx.Err() == nil {
				return nil, context.DeadlineExceeded
			}
			return nil, err
		}
		if v == nil {
			return nil, nil
		}
		return v.RawJSON(), nil
	}
	return nil, fmt.Errorf("waiting on %s is not supported by this CLI yet; follow it with its watch command", strings.TrimPrefix(lr.Watch, "Watch"))
}

// Spinner shows a spinner on stderr while a call runs, after 150 ms, on a terminal only (12.7). The returned
// function stops it. Replaced by the ui package's spinner.
var Spinner = func(f *cmdutil.Factory, u interface{}, label string) func() { return func() {} }

var _ = invoke.Event{}
