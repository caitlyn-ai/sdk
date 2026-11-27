package hand

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/ci"
	"github.com/caitlyn-ai/sdk/cli/internal/ci/cisession"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// phase opens a CI phase (a collapsible section, a group) and returns the function that ends it (15.4).
func phase(f *cmdutil.Factory, id, title string, detail bool) func(failed bool) {
	var opts []ci.PhaseOption
	if detail {
		opts = append(opts, ci.Detail())
	}
	ph := cisession.For(f).Phase(id, title, opts...)
	return func(failed bool) {
		if failed {
			ph.Fail("")
		} else {
			ph.Done()
		}
	}
}

// caseOf records one checked item for --report junit (15.5).
func caseOf(f *cmdutil.Factory, suite, name string, status ci.Status, message string) {
	cisession.For(f).Case(ci.TestCase{Suite: suite, Name: name, Status: status, Message: message})
}

// Progress shows a phase's progress; the design system replaces it with a bar on a terminal and plain lines in CI.
var Progress = func(f *cmdutil.Factory, u *ui.UI) func(label string, done, total int, bytes, totalBytes int64) {
	last := time.Time{}
	return func(label string, done, total int, b, tb int64) {
		if !f.IO.IsStderrTTY() && time.Since(last) < 10*time.Second && done != total {
			return
		}
		last = time.Now()
		if f.IO.IsStderrTTY() && f.IO.Decorate {
			fmt.Fprintf(f.IO.ErrOut, "\r\x1b[2K  %s  %d of %d", label, done, total)
			if done == total {
				fmt.Fprint(f.IO.ErrOut, "\r\x1b[2K")
			}
			return
		}
		stamp := ""
		if f.CI.In() {
			stamp = time.Now().Format("15:04:05") + " "
		}
		fmt.Fprintf(f.IO.ErrOut, "%s%s: %d of %d\n", stamp, label, done, total)
	}
}

type syncOptions struct {
	folder          string
	include         []string
	exclude         []string
	removeMissing   bool
	onConflict      string
	concurrency     int
	cancelInterrupt bool
	estimate        bool
	timeout         time.Duration
}

// NewSync returns `caitlyn kb sync` (2.5): the SDK's ingestion sync helper. Hash locally, plan on the server,
// confirm, upload under one policy, wait, and report.
func NewSync(f *cmdutil.Factory) *cobra.Command {
	o := &syncOptions{}
	cmd := &cobra.Command{
		Use:   "sync [KB] <folder>",
		Short: "Keep a knowledge base in step with a folder",
		Long: `Keeps a knowledge base folder in step with a folder on disk, through one ingestion batch: every file is hashed
here, the server plans what changes (new, changed, moved, unchanged), you confirm, the files that need their bytes
are uploaded, and the CLI waits until they're processed.

Exit codes: 0 when everything is in step; 1 when some items failed; 3 when the plan has items that need a decision
(--on-conflict answers them) or a confirmation was needed with no terminal (--yes).`,
		Example: `  caitlyn kb sync KB4T7YQ2WL ./handbook --folder /policies/
  caitlyn kb sync KB4T7YQ2WL ./handbook --remove-missing --yes --timeout 30m
  caitlyn kb sync KB4T7YQ2WL ./handbook --estimate`,
		Args:        cobra.RangeArgs(1, 2),
		Annotations: map[string]string{"impact": "write", "scope": "knowledge-bases:write,files:write", "operation": "CreateIngestionBatch,StartIngestionBatch"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSync(cmd.Context(), f, o, args)
		},
	}
	fl := cmd.Flags()
	fl.StringVar(&o.folder, "folder", "/", "The knowledge base folder the files go to")
	fl.StringArrayVar(&o.include, "include", nil, "Only files matching this glob (repeatable): '*.pdf', 'hr/**'")
	fl.StringArrayVar(&o.exclude, "exclude", nil, "Leave out files matching this glob (repeatable)")
	fl.BoolVar(&o.removeMissing, "remove-missing", false, "Remove documents under --folder that have no file")
	fl.StringVar(&o.onConflict, "on-conflict", "", "How to resolve items the policy leaves open: new-version, overwrite, add or skip")
	fl.IntVar(&o.concurrency, "concurrency", 0, "Files uploaded at once (default 6)")
	fl.BoolVar(&o.cancelInterrupt, "cancel-on-interrupt", false, "Ctrl-C also cancels the batch, not only the wait")
	fl.BoolVar(&o.estimate, "estimate", false, "Plan and price it, upload nothing")
	fl.DurationVar(&o.timeout, "timeout", 0, "The wait's time limit, for example 30m (exit 9)")
	return cmd
}

func runSync(ctx context.Context, f *cmdutil.Factory, o *syncOptions, args []string) error {
	cfg, err := f.Config()
	if err != nil {
		return err
	}
	kb, dir := "", ""
	if len(args) == 2 {
		kb, dir = args[0], args[1]
	} else {
		kb, dir = cfg.String("knowledge_base"), args[0]
		// Removing documents never takes its knowledge base from the project file: a cloned repository mustn't
		// choose what you delete
		if o.removeMissing && cfg.Get("knowledge_base").Origin == config.FromProject {
			e := cmdutil.Usagef("--remove-missing needs the knowledge base named on the command line: caitlyn kb sync KB <folder> --remove-missing.")
			e.Detail = "The project file's knowledge_base isn't used for a sync that removes documents."
			return e
		}
	}
	if kb == "" {
		e := cmdutil.Usagef("Name the knowledge base: caitlyn kb sync KB <folder>.")
		e.AddNext("caitlyn kb list", "find a knowledge base")
		return e
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return cmdutil.Usagef("%s is not a folder.", dir)
	}
	run := cisession.For(f)
	if err := run.AcceptFailOn(ci.SyncConditions, ci.SyncDefaults); err != nil {
		return err
	}
	if o.removeMissing {
		// Removing documents is destructive: the read-only, agent-scope and --yes checks of a delete (18.5). A
		// person at a terminal confirms the plan itself below.
		// --confirm names the knowledge base, as kb delete's does
		action := gen.Action{Name: "caitlyn kb sync --remove-missing", Impact: "destructive", Scopes: gen.ScopesOf(f.Manifest(), "BatchDeleteDocuments"), Targets: []string{kb}}
		if err := gen.Allowed(f, action); err != nil {
			return err
		}
		if f.Agent.On || f.CI.In() || !f.Interactive() {
			if err := gen.Confirmed(f, action); err != nil {
				return err
			}
		}
	}
	var resolution caitlyn.IngestionItemResolution
	if o.onConflict != "" {
		resolution = caitlyn.IngestionItemResolution(strings.ReplaceAll(o.onConflict, "-", "_"))
	}
	limit := o.timeout
	if limit == 0 && f.Agent.On {
		limit = gen.AgentWaitDefault
	}
	if limit == 0 && f.CI.In() {
		gen.UIFor(f).Warnf("kb sync has no --timeout: set one, so a stuck batch fails this step instead of the runner's job timeout.")
	}
	_, tc, err := f.Clients(ctx)
	if err != nil {
		return err
	}
	u := gen.UIFor(f)
	p, err := output.New(f, u)
	if err != nil {
		return err
	}
	progress := Progress(f, u)
	var mu sync.Mutex
	phaseEnd := func(bool) {}
	currentPhase := ""
	opts := &caitlyn.SyncOptions{
		Folder:          o.folder,
		Include:         o.include,
		Exclude:         o.exclude,
		RemoveMissing:   o.removeMissing,
		Concurrency:     o.concurrency,
		CancelIngestion: o.cancelInterrupt,
		OnProgress: func(pr caitlyn.IngestionProgress) {
			mu.Lock()
			defer mu.Unlock()
			if string(pr.Phase) != currentPhase {
				phaseEnd(false)
				currentPhase = string(pr.Phase)
				phaseEnd = phase(f, "caitlyn_"+currentPhase, phaseTitle(pr.Phase), pr.Phase != caitlyn.SyncPhaseProcessing)
			}
			label := phaseTitle(pr.Phase)
			if pr.Total > 0 {
				progress(label, pr.Done, pr.Total, pr.BytesSent, pr.BytesTotal)
			}
		},
	}
	if limit > 0 {
		opts.WaitOptions = []caitlyn.WaitOption{caitlyn.WithTimeLimit(limit)}
	}
	if resolution != "" {
		opts.Resolve = func(context.Context, caitlyn.IngestionBatchItem) (caitlyn.IngestionItemResolution, error) {
			return resolution, nil
		}
	}
	if o.estimate {
		// Sync with a confirm that keeps the plan and declines it: the confirm gets the plan even when pricing is
		// unavailable (with estimateError, PROTOCOL.md 15), where EstimateSync would only raise the error. Declining
		// cancels the batch before anything is uploaded.
		var plan *caitlyn.SyncPlan
		opts.Confirm = func(_ context.Context, pl *caitlyn.SyncPlan) (bool, error) {
			plan = pl
			return false, nil
		}
		_, err := tc.KnowledgeBase(kb).Ingestion.Sync(ctx, caitlyn.Dir(dir), opts)
		var declined *caitlyn.SyncDeclinedError
		if plan == nil || !errors.As(err, &declined) {
			phaseEnd(true)
			if err == nil {
				err = fmt.Errorf("the sync ended without a plan")
			}
			return syncError(err, kb)
		}
		phaseEnd(false)
		return printPlan(f, u, p, plan)
	}
	opts.Confirm = func(ctx context.Context, plan *caitlyn.SyncPlan) (bool, error) {
		if p.Human || f.IO.IsStderrTTY() {
			describePlan(f, u, plan)
		}
		if f.Globals.Yes {
			return true, nil
		}
		if !changes(plan) {
			return true, nil
		}
		pr, err := prompt.For(f.IO)
		if err != nil {
			return false, cmdutil.ActionNeeded("Applying the plan needs a confirmation, and there's no terminal to ask on.", "--yes")
		}
		return pr.Confirm("Apply this plan to the knowledge base "+kb+"?", false)
	}
	report, err := tc.KnowledgeBase(kb).Ingestion.Sync(ctx, caitlyn.Dir(dir), opts)
	phaseEnd(err != nil)
	if err != nil {
		var declined *caitlyn.SyncDeclinedError
		if errors.As(err, &declined) {
			return &cmdutil.Error{Exit: exitcode.ActionNeeded, Code: "CANCELLED", Title: "Nothing was changed: the plan wasn't applied."}
		}
		return syncError(err, kb)
	}
	return finishSync(f, u, p, report, run, kb)
}

func syncError(err error, kb string) error {
	var api *caitlyn.Error
	if errors.As(err, &api) && api.Code == "INGESTION_BATCH_UNRESOLVED" {
		e := cmdutil.FromError(err)
		e.Exit = exitcode.ActionNeeded
		e.AddNext("caitlyn kb sync "+kb+" <folder> --on-conflict new-version", "answer every open item the same way")
		return e
	}
	return err
}

func phaseTitle(p caitlyn.SyncPhase) string {
	switch p {
	case caitlyn.SyncPhaseChecksum:
		return "Hashing"
	case caitlyn.SyncPhasePlanning:
		return "Planning"
	case caitlyn.SyncPhasePlanned:
		return "Planned"
	case caitlyn.SyncPhaseUpload:
		return "Uploading"
	case caitlyn.SyncPhaseQueued:
		return "Queued"
	case caitlyn.SyncPhaseProcessing:
		return "Processing"
	}
	return strings.ToUpper(string(p)[:1]) + strings.ReplaceAll(string(p)[1:], "_", " ")
}

// outcomeCounts tallies the plan's items by outcome.
func outcomeCounts(items []caitlyn.IngestionBatchItem) map[string]int {
	out := map[string]int{}
	for _, it := range items {
		k := "planned"
		if it.Outcome != nil {
			k = string(*it.Outcome)
		}
		out[k]++
	}
	return out
}

func changes(plan *caitlyn.SyncPlan) bool {
	for k, n := range outcomeCounts(plan.Items) {
		if k != "unchanged" && k != "skip" && n > 0 {
			return true
		}
	}
	return false
}

func describePlan(f *cmdutil.Factory, u *ui.UI, plan *caitlyn.SyncPlan) {
	counts := outcomeCounts(plan.Items)
	var parts []string
	for _, k := range []string{"add", "new_version", "move", "update", "remove", "unchanged", "unresolved"} {
		if n := counts[k]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, strings.ReplaceAll(k, "_", " ")))
			delete(counts, k)
		}
	}
	for k, n := range counts {
		parts = append(parts, fmt.Sprintf("%d %s", n, strings.ReplaceAll(k, "_", " ")))
	}
	if len(parts) == 0 {
		parts = []string{"nothing to do"}
	}
	u.Successf("Planned: %s", strings.Join(parts, ", "))
	if n := planBytes(plan); n > 0 {
		u.Infof("  To upload: %s", humanBytes(n))
	}
	if e := plan.Estimate; e != nil {
		u.Infof("  Estimate: %s", estimateLine(e))
	} else if plan.EstimateErr != nil {
		u.Infof("  Price unavailable: %s", cmdutil.FromError(plan.EstimateErr).Title)
	}
}

// estimateLine says what a sync is expected to take, for people: "2 documents, 28 seconds to 1 minute, US$0.01".
func estimateLine(e *caitlyn.EstimateIngestionResult) string {
	parts := []string{fmt.Sprintf("%d document%s", e.Documents, map[bool]string{true: "", false: "s"}[e.Documents == 1])}
	if e.Pages != nil && *e.Pages > 0 {
		parts = append(parts, fmt.Sprintf("%d pages", *e.Pages))
	}
	dur := func(sec float64) string {
		if sec < 90 {
			return fmt.Sprintf("%.0f seconds", sec)
		}
		return fmt.Sprintf("%.0f minutes", sec/60)
	}
	if lo, hi := e.DurationSeconds.Low, e.DurationSeconds.High; hi > 0 {
		if dur(lo) == dur(hi) {
			parts = append(parts, "about "+dur(hi))
		} else {
			parts = append(parts, dur(lo)+" to "+dur(hi))
		}
	}
	if c := e.Cost; c != nil {
		money := func(v float64) string {
			if c.Unit == "percent_of_plan" {
				return fmt.Sprintf("%.2g%% of your plan", v)
			}
			return fmt.Sprintf("US$%.2f", v)
		}
		if money(c.Low) == money(c.High) {
			parts = append(parts, money(c.High))
		} else {
			parts = append(parts, money(c.Low)+" to "+money(c.High))
		}
	}
	return strings.Join(parts, ", ")
}

func printPlan(f *cmdutil.Factory, u *ui.UI, p *output.Printer, plan *caitlyn.SyncPlan) error {
	if p.Human {
		describePlan(f, u, plan)
		u.Infof("Nothing was uploaded, and the plan's batch was cancelled.")
		return nil
	}
	out := struct {
		Batch       *caitlyn.IngestionBatch
		Items       []caitlyn.IngestionBatchItem
		Bytes       int64                            `json:"bytes"`
		Estimate    *caitlyn.EstimateIngestionResult `json:"Estimate"`
		EstimateErr *estimateError                   `json:"estimateError,omitempty"`
	}{Batch: plan.Batch, Items: plan.Items, Bytes: planBytes(plan), Estimate: plan.Estimate}
	if plan.EstimateErr != nil {
		e := cmdutil.FromError(plan.EstimateErr)
		out.EstimateErr = &estimateError{Code: e.Code, Message: e.Title}
	}
	return p.Value(out, "")
}

// estimateError is why a plan has no price, in --estimate's JSON.
type estimateError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// planBytes is the most the plan would upload: the bytes of its new and changed items, and of its conflicts, which
// may need them.
func planBytes(plan *caitlyn.SyncPlan) int64 {
	var n int64
	for _, it := range plan.Items {
		if it.ByteSize == nil || it.Outcome == nil {
			continue
		}
		switch *it.Outcome {
		case caitlyn.IngestionItemOutcomeNew, caitlyn.IngestionItemOutcomeChanged, caitlyn.IngestionItemOutcomeConflict:
			n += *it.ByteSize
		}
	}
	return n
}

func finishSync(f *cmdutil.Factory, u *ui.UI, p *output.Printer, r *caitlyn.SyncReport, run *cisession.Run, kb string) error {
	failed, skipped := 0, 0
	for _, it := range r.Items {
		name := it.Path
		if name == nil {
			name = it.ExternalID
		}
		label := "item"
		if name != nil {
			label = *name
		}
		st := string(it.Status)
		isFailed := st == "failed"
		msg := ""
		if isFailed && it.FailureCode != nil {
			msg = *it.FailureCode
			if it.FailureDetail != nil {
				msg += ": " + *it.FailureDetail
			}
		}
		if isFailed {
			failed++
		}
		if st == "skipped" {
			skipped++
		}
		status := ci.Passed
		switch {
		case isFailed:
			status = ci.Failed
		case st == "skipped":
			status = ci.Skipped
		}
		caseOf(f, "kb sync", label, status, msg)
	}
	if r.Batch != nil {
		_ = run.Output("batch_id", r.Batch.ID)
		_ = run.Output("knowledge_base_id", kb)
	}
	if !p.Human {
		if err := p.Value(r, ""); err != nil {
			return err
		}
	} else {
		status := ""
		if r.Batch != nil {
			status = string(r.Batch.Status)
		}
		if failed == 0 {
			u.Successf("The knowledge base is in step with the folder.")
		} else {
			u.Warnf("%d of %d items failed (batch %s).", failed, len(r.Items), status)
			if r.Batch != nil {
				u.Nextf("caitlyn kb ingestion batches items list --kb %s --batch %s --status failed", kb, r.Batch.ID)
			}
		}
	}
	run.Summary("kb sync", fmt.Sprintf("%d items, %d failed, %d skipped.", len(r.Items), failed, skipped))
	if failed > 0 {
		run.Hold("failed")
		run.Hold("partial")
	}
	if skipped > 0 {
		run.Hold("skipped")
	}
	return run.Finish(0)
}

// humanBytes is a byte count for people: "820 bytes", "1.4 MB" (decimal units).
func humanBytes(n int64) string {
	if n < 1000 {
		return fmt.Sprintf("%d bytes", n)
	}
	v, units := float64(n), []string{"kB", "MB", "GB", "TB"}
	for i, unit := range units {
		v /= 1000
		if v < 1000 || i == len(units)-1 {
			return fmt.Sprintf("%.1f %s", v, unit)
		}
	}
	return ""
}
