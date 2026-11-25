// This file is hand-written, not generated: the answer's text as it arrives, from a conversation's stream (spec 1,
// "Chat with an agent"). scripts/generate.sh keeps every file in go/ that is not marked as generated.

package caitlyn

import (
	"iter"

	"github.com/caitlyn-ai/sdk/go/core"
)

// Text yields the text of an answer as it arrives: each text.delta's delta, in order, from a conversation's stream or
// an unattended run's watch. Other events are skipped; an error ends the iteration with it. The stream's FinalMessage
// still gives its final event afterwards, even after a break (a conversation's message; a run's watch, the ended run);
// close the stream when you are done (defer stream.Close()), or cancel its context.
//
//	defer stream.Close()
//	for text, err := range caitlyn.Text(stream) { … }
func Text[E any, F any](stream *core.Stream[E, F]) iter.Seq2[string, error] {
	return func(yield func(string, error) bool) {
		for event, err := range stream.Events() {
			if err != nil {
				yield("", err)
				return
			}
			if d, ok := any(event).(*TextDelta); ok && !yield(d.Delta, nil) {
				return
			}
		}
	}
}
