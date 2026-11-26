package invoke

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/spec"
	"github.com/caitlyn-ai/sdk/go/core"
)

// Event is one server-sent event as received: its name, id and data.
type Event struct {
	Type string
	ID   string
	Data json.RawMessage
}

// Stream is an operation's event stream, with the SDK's reconnects (Last-Event-ID, backoff, the hourly clean end).
type Stream = core.Stream[Event, json.RawMessage]

// Open sends an @sseEvents operation and returns its stream. Every event is delivered, known or not (the CLI prints
// unknown events in JSON Lines and skips them for people). On a stream with a final event, the failure event
// (message.failed) ends it with its error, as the SDKs do.
func Open(ctx context.Context, c *core.Client, m *spec.Manifest, op *spec.Operation, in *Input) (*Stream, error) {
	req, err := Build(op, in)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(ctx, Operation(op), req, in.Options())
	if err != nil {
		return nil, err
	}
	finalWire := ""
	fresh := false
	if op.SSE != nil {
		for _, t := range op.SSE.EventTypes {
			if t == "snapshot" {
				fresh = true
			}
		}
		if op.SSE.Final != "" && op.SSE.Events != nil {
			if sh := m.Shapes[op.SSE.Events.Ref]; sh != nil {
				for _, mem := range sh.Members {
					if mem.Name == op.SSE.Final {
						finalWire = mem.Wire
					}
				}
			}
		}
	}
	resume := m.Op(op.Name)
	if op.SSE != nil && op.SSE.ResumeWith != "" && m.Op(op.SSE.ResumeWith) != nil {
		resume = m.Op(op.SSE.ResumeWith)
	}
	errorFor := func(_ int, e *core.APIError) error { return e }
	spec := core.StreamSpec[Event, json.RawMessage]{
		Decode: func(name, id string, data []byte) (Event, bool, error) {
			if name == "error" || (finalWire != "" && strings.HasSuffix(name, ".failed")) {
				return Event{}, false, core.ProblemFromEvent(data, errorFor)
			}
			return Event{Type: name, ID: id, Data: append(json.RawMessage(nil), data...)}, true, nil
		},
		Fresh: fresh,
	}
	if finalWire != "" {
		spec.Final = func(ev Event) (*json.RawMessage, bool) {
			if ev.Type != finalWire {
				return nil, false
			}
			d := ev.Data
			return &d, true
		}
	}
	if resume != nil {
		spec.Resume = func(ctx context.Context, lastEventID string) (*core.Response, error) {
			rin := NewInput()
			for _, mem := range resume.Input {
				if v, ok := in.Values[mem.Name]; ok {
					rin.Set(mem.Name, v)
				}
			}
			if lastEventID != "" {
				rin.Header.Set("Last-Event-ID", lastEventID)
			}
			rreq, err := Build(resume, rin)
			if err != nil {
				return nil, err
			}
			return c.Do(ctx, Operation(resume), rreq, nil)
		}
	}
	return core.OpenStream(ctx, resp, spec), nil
}
