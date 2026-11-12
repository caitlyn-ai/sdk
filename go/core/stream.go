package core

import (
	"bufio"
	"context"
	"errors"
	"io"
	"iter"
	"strings"
)

// maxReconnects is PROTOCOL.md 5.6's limit.
const maxReconnects = 3

// StreamSpec is what generated code supplies for one @sseEvents operation.
type StreamSpec[E any, F any] struct {
	// Decode turns one SSE event into a typed event. ok is false for an event name the SDK does not know
	// (skipped, PROTOCOL.md 5.2). An `error` event returns its typed error.
	Decode func(name, id string, data []byte) (ev E, ok bool, err error)
	// Final returns the final event's single member, if ev is the final event (nil when the union has none).
	Final func(ev E) (*F, bool)
	// Resume re-attaches with Last-Event-ID (nil without resumeWith).
	Resume func(ctx context.Context, lastEventID string) (*Response, error)
}

// Stream is a typed server-sent event stream. Iterate it with Events; FinalMessage drains what is left and
// returns the final event's member. Always Close it (closing twice is fine); a stream that ran to its end
// closes itself.
//
// Events is a range-over-func iterator: the loop body runs on the caller's goroutine, so there is no
// goroutine to leak, back-pressure is natural, and errors arrive in the loop. Breaking out of the loop
// leaves the stream open, so FinalMessage can still drain it.
type Stream[E any, F any] struct {
	ctx        context.Context
	spec       StreamSpec[E, F]
	resp       *Response
	r          *bufio.Reader
	seen       map[string]struct{}
	lastID     string
	reconnects int
	final      *F
	done       bool
	err        error
	requestID  string
	apiVersion string
	// onResponse counts the SSE events (known or not) the current response has carried.
	onResponse int
}

// OpenStream wraps a 2xx text/event-stream response.
func OpenStream[E any, F any](ctx context.Context, resp *Response, spec StreamSpec[E, F]) *Stream[E, F] {
	s := &Stream[E, F]{ctx: ctx, spec: spec, seen: map[string]struct{}{}}
	s.attach(resp)
	s.requestID = resp.Header.Get("Caitlyn-Request-Id")
	s.apiVersion = resp.Header.Get("Caitlyn-Api-Version")
	return s
}

func (s *Stream[E, F]) attach(resp *Response) {
	s.resp = resp
	s.r = bufio.NewReaderSize(resp.Body, 64<<10)
	s.onResponse = 0
}

// RequestID is the Caitlyn-Request-Id of the response that opened the stream.
func (s *Stream[E, F]) RequestID() string { return s.requestID }

// APIVersion is the Caitlyn-Api-Version of the response that opened the stream.
func (s *Stream[E, F]) APIVersion() string { return s.apiVersion }

// Close releases the connection.
func (s *Stream[E, F]) Close() error {
	s.done = true
	if s.resp != nil {
		err := s.resp.Body.Close()
		s.resp = nil
		return err
	}
	return nil
}

// Events yields each known event once. After an error the iteration ends.
func (s *Stream[E, F]) Events() iter.Seq2[E, error] {
	return func(yield func(E, error) bool) {
		for {
			ev, err := s.next()
			if errors.Is(err, io.EOF) {
				return
			}
			if err != nil {
				var zero E
				yield(zero, err)
				return
			}
			if !yield(ev, nil) {
				return
			}
		}
	}
}

// FinalMessage drains the stream if needed and returns the final event's member.
func (s *Stream[E, F]) FinalMessage() (*F, error) {
	for _, err := range s.Events() {
		if err != nil {
			return nil, err
		}
	}
	if s.err != nil {
		return nil, s.err
	}
	if s.final == nil {
		return nil, sdkError("NO_FINAL_EVENT", "The stream ended without its final event", nil)
	}
	return s.final, nil
}

func (s *Stream[E, F]) fail(err error) error {
	s.err = err
	s.Close()
	return err
}

// next returns the next known event, io.EOF at the end, or the error that ended the stream.
func (s *Stream[E, F]) next() (E, error) {
	var zero E
	for {
		if s.err != nil {
			return zero, s.err
		}
		if s.done {
			return zero, io.EOF
		}
		name, id, data, err := s.readEvent()
		if err != nil {
			if cerr := s.ctx.Err(); cerr != nil {
				return zero, s.fail(cerr)
			}
			clean := errors.Is(err, io.EOF)
			// A response that ends cleanly without any event means the answer had already finished: the stream
			// ends, without an error and without reconnecting (PROTOCOL.md 5.6).
			if clean && (s.spec.Final == nil || s.final != nil || s.onResponse == 0) {
				s.Close()
				return zero, io.EOF
			}
			if s.spec.Resume == nil {
				if clean {
					return zero, s.fail(sdkError("NO_FINAL_EVENT", "The stream ended without its final event", nil))
				}
				return zero, s.fail(err)
			}
			if rerr := s.reconnect(err); rerr != nil {
				return zero, s.fail(rerr)
			}
			continue
		}
		s.onResponse++
		if id != "" {
			if _, dup := s.seen[id]; dup {
				continue
			}
			s.seen[id] = struct{}{}
			s.lastID = id
		}
		if name == "" {
			name = "message"
		}
		ev, ok, derr := s.spec.Decode(name, id, data)
		if derr != nil {
			return zero, s.fail(derr)
		}
		if !ok {
			continue
		}
		if s.spec.Final != nil {
			if f, isFinal := s.spec.Final(ev); isFinal {
				s.final = f
				s.Close()
			}
		}
		return ev, nil
	}
}

// reconnect re-attaches with Last-Event-ID, at most maxReconnects times in all (PROTOCOL.md 5.6).
func (s *Stream[E, F]) reconnect(cause error) error {
	if s.resp != nil {
		s.resp.Body.Close()
		s.resp = nil
	}
	for {
		if s.reconnects >= maxReconnects {
			return sdkError("STREAM_LOST", "The stream was lost and could not be resumed", cause)
		}
		s.reconnects++
		resp, err := s.spec.Resume(s.ctx, s.lastID)
		if err == nil {
			s.attach(resp)
			return nil
		}
		if s.ctx.Err() != nil {
			return s.ctx.Err()
		}
		cause = err
	}
}

// readEvent reads one SSE event (PROTOCOL.md 5.1): comment lines and retry: are ignored.
func (s *Stream[E, F]) readEvent() (name, id string, data []byte, err error) {
	var buf strings.Builder
	hasData := false
	for {
		line, rerr := s.r.ReadString('\n')
		if rerr != nil {
			// A partial line at the end of the body is an incomplete event: discard it.
			return "", "", nil, rerr
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if !hasData && name == "" {
				continue
			}
			return name, id, []byte(buf.String()), nil
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			name = value
		case "data":
			if hasData {
				buf.WriteByte('\n')
			}
			buf.WriteString(value)
			hasData = true
		case "id":
			id = value
		}
	}
}
