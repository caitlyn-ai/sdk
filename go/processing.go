// This file is hand-written, not generated: a thing's processing, read the same way from a watch's snapshot and its
// progress events (PROTOCOL.md 16, watch.processing), and wait's progress callback (wait.progress).
// scripts/generate.sh keeps every file in go/ that is not marked as generated.

package caitlyn

import "github.com/caitlyn-ai/sdk/go/core"

// Processing is how far the work on a thing has got. A document's is its DocumentProcessing; a batch's or a
// folder's (or a fill-in's) is its running Job. Stage, Percent and Eta read either.
type Processing struct {
	// Stage is a document's stage (pages, passages, index…); nil for a job.
	Stage *ProcessingStep
	// Percent never goes backwards, and reaches 100 only when the work is done.
	Percent *int32
	// Eta is how long is left, as a range of seconds, when the server can say.
	Eta *Eta
	// Document is a document's processing, as the server sent it.
	Document *DocumentProcessing
	// Job is a batch's, a folder's or a job's own processing: the running job.
	Job *Job
}

func documentProcessing(p DocumentProcessing) *Processing {
	return &Processing{Stage: p.Stage, Percent: Ptr(p.Percent), Eta: p.Eta, Document: &p}
}

func jobProcessing(j Job) *Processing {
	return &Processing{Percent: j.Percent, Eta: j.Eta, Job: &j}
}

// processingOf is every watch event's GetProcessing ("" for want) and ProcessingOf. Without an identifier it reads the
// watched thing's: a snapshot's document, or its running job (a batch's or a folder's watch); with one, the document's
// or the job's that it names. A snapshot's documents' processing is in its Progress list.
func processingOf(ev KnowledgeBaseEvent, want string) *Processing {
	switch e := ev.(type) {
	case *KnowledgeBaseSnapshot:
		doc := want
		if doc == "" && e.Document != nil {
			doc = e.Document.ID
		}
		if doc != "" {
			for _, p := range e.Progress {
				if p.DocumentID == doc {
					return documentProcessing(p.Processing)
				}
			}
		}
		if want == "" && e.Document != nil {
			if e.Document.Processing != nil {
				return documentProcessing(*e.Document.Processing)
			}
			return nil
		}
		if want == "" && e.KnowledgeBase != nil {
			return nil // the knowledge base's own watch: name the document or job
		}
		for _, j := range e.Jobs {
			if (want == "" || j.ID == want) && running(j.Status) {
				return jobProcessing(j)
			}
		}
	case *DocumentProgress:
		if want == "" || e.DocumentID == want {
			return documentProcessing(e.Processing)
		}
	case *JobChanged:
		if e.EventType() == "job.progress" && (want == "" || e.Job.ID == want) {
			return jobProcessing(e.Job)
		}
	case *DocumentChanged:
		if (want == "" || e.Document.ID == want) && e.Document.Processing != nil {
			return documentProcessing(*e.Document.Processing)
		}
	}
	return nil
}

// WithProgress has Wait call fn with the thing's processing as the wait sees it: the snapshot's first, if the thing is
// being processed, then each progress event's, in order, once each. It is never called after Wait has returned.
//
//	kb.Document(id).Wait(ctx, caitlyn.WithProgress(func(p caitlyn.Processing) { fmt.Println(*p.Percent) }))
func WithProgress(fn func(Processing)) WaitOption {
	return func(s *core.WaitSettings) { s.Progress = func(v any) { fn(v.(Processing)) } }
}
