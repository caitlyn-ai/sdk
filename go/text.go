// This file is hand-written, not generated: the answer's text as it arrives, from a conversation's stream (spec 1,
// "Chat with an agent"). scripts/generate.sh keeps every file in go/ that is not marked as generated.

package caitlyn

import "iter"

// Text yields the text of an answer as it arrives: each text.delta's delta, in order. Other events are skipped; an
// error ends the iteration with it. The stream's FinalMessage still gives the whole message afterwards, even after a
// break; close the stream when you are done (defer stream.Close()), or cancel its context.
//
//	defer stream.Close()
//	for text, err := range caitlyn.Text(stream) { … }
func Text(stream *ConversationEventStream) iter.Seq2[string, error] {
	return func(yield func(string, error) bool) {
		for event, err := range stream.Events() {
			if err != nil {
				yield("", err)
				return
			}
			if d, ok := event.(*TextDelta); ok && !yield(d.Delta, nil) {
				return
			}
		}
	}
}
