package core

import (
	"bufio"
	"context"
	"errors"
	"io"
	"iter"
	"math/rand/v2"
	"strings"
	"time"
)

// maxReconnects is PROTOCOL.md 5.6's limit.
const maxReconnects = 3

// LongConnection is how long a connection must stay open before it ends for its end to restart the reconnect
// count (PROTOCOL.md 5.6).
const LongConnection = time.Minute

// StreamClock is the clock that times each stream connection, for the LongConnection rule. Replace it only in tests,
// and put it back afterwards: the conformance cases step it so that a connection lasts an hour, or under a minute,
// without waiting.
var StreamClock = time.Now

// ReconnectDelay is the pause before the nth reconnect in a row (PROTOCOL.md 5.6): an exponential backoff with
// jitter, 0.25-0.5 s, then 0.5-1 s, then 1-2 s, so each pause is longer than the last.
func ReconnectDelay(attempt int) time.Duration {
	attempt = min(max(attempt, 1), 5) // 500 ms × 2^4 already passes the 8 s cap
	d := min(8*time.Second, 500*time.Millisecond<<(attempt-1))
	return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
}

// StreamSpec is what generated code supplies for one @sseEvents operation.
type StreamSpec[E any, F any] struct {
	// Decode turns one SSE event into a typed event. ok is false for an event name the SDK does not know
	// (skipped, PROTOCOL.md 5.2). An `error` event returns its typed error.
	Decode func(name, id string, data []byte) (ev E, ok bool, err error)
	// Final returns the final event's single member, if ev is the final event (nil when the union has none).
	Final func(ev E) (*F, bool)
	// Resume re-attaches with Last-Event-ID (nil without resumeWith).
	Resume func(ctx context.Context, lastEventID string) (*Response, error)
	// Fresh marks a watch whose every connection starts again with a snapshot (PROTOCOL.md 16): Resume is called with
	// no cursor, and each connection's events are all delivered, the new snapshot first. An event counts as new for
	// the reconnect limit only when its id was never seen on any connection.
	Fresh bool
}

// Stream is a typed server-sent event stream. Iterate it with Events; FinalMessage drains what is left and
// returns the final event's member. Always Close it (closing twice is fine); a stream that ran to its end
// closes itself.
//
// Events is a range-over-func iterator: the loop body runs on the caller's goroutine, so there is no
// goroutine to leak, back-pressure is natural, and errors arrive in the loop. Breaking out of the loop
// over a stream with a final event leaves it open, so FinalMessage can still drain it: call FinalMessage or
// Close (defer stream.Close()), or cancel the context, or its connection stays open. Breaking out of a
// watch (a stream with no final event) closes it, and its connection with it. Cancelling the context
// closes the connection either way.
type Stream[E any, F any] struct {
	ctx        context.Context
	spec       StreamSpec[E, F]
	resp       *Response
	r          *bufio.Reader
	seen       map[string]struct{}
	ever       map[string]struct{} // Fresh: every id seen on any connection
	lastID     string
	reconnects int
	// attempts counts the reconnects since the last event: at most maxReconnects in a row (PROTOCOL.md 5.6).
	attempts int
	// openedAt is when the current connection's response arrived (StreamClock), zero between connections.
	openedAt time.Time
	// onConnection counts the events read on the current connection: on a Fresh watch the first, its snapshot, is
	// not progress towards STREAM_LOST, whatever its id (PROTOCOL.md 5.6).
	onConnection int
	// snapshotted: the current connection began with a snapshot of the thing (an unattended run's watch), so a
	// stream.reset on it does not end the stream (PROTOCOL.md 5.9).
	snapshotted bool
	final       *F
	done        bool
	err         error
	requestID   string
	apiVersion  string
	// inter adds events of the SDK's own between the server's (Interject); cancel ends the context the stream was
	// opened with, so that its reader stops.
	inter  Interjector[E]
	cancel context.CancelFunc
}

// Interjector adds events of the SDK's own to a stream, between the server's: a batch's watch reading the batch once
// its deadline has passed (PROTOCOL.md 16).
type Interjector[E any] interface {
	// See takes each event the server sent, and returns the event to yield: the same one, or one made in its place.
	See(ctx context.Context, ev E) (E, error)
	// Due is when the interjector's next event is due, if one is.
	Due() (time.Time, bool)
	// Fire makes that event, once it is due.
	Fire(ctx context.Context) (E, error)
}

// Interject has Events yield i's events beside the server's. The stream is then read on a goroutine of its own, so
// cancel must end the context the stream was opened with: leaving the loop, or Close, calls it.
func (s *Stream[E, F]) Interject(i Interjector[E], cancel context.CancelFunc) *Stream[E, F] {
	s.inter, s.cancel = i, cancel
	return s
}

// OpenStream wraps a 2xx text/event-stream response.
func OpenStream[E any, F any](ctx context.Context, resp *Response, spec StreamSpec[E, F]) *Stream[E, F] {
	s := &Stream[E, F]{ctx: ctx, spec: spec, seen: map[string]struct{}{}, ever: map[string]struct{}{}}
	s.attach(resp)
	s.requestID = resp.Header.Get("Caitlyn-Request-Id")
	s.apiVersion = resp.Header.Get("Caitlyn-Api-Version")
	return s
}

func (s *Stream[E, F]) attach(resp *Response) {
	s.openedAt = StreamClock()
	s.onConnection = 0
	s.snapshotted = false
	s.resp = resp
	s.r = bufio.NewReaderSize(resp.Body, 64<<10)
}

// RequestID is the Caitlyn-Request-Id of the response that opened the stream.
func (s *Stream[E, F]) RequestID() string { return s.requestID }

// APIVersion is the Caitlyn-Api-Version of the response that opened the stream.
func (s *Stream[E, F]) APIVersion() string { return s.apiVersion }

// Close releases the connection.
func (s *Stream[E, F]) Close() error {
	if s.cancel != nil {
		s.cancel()
	}
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
		if s.inter != nil {
			s.interjected(yield)
			return
		}
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
				// A watch has nothing left to drain: leaving it ends it (PROTOCOL.md 5, watch.break-closes)
				if s.spec.Final == nil {
					s.Close()
				}
				return
			}
		}
	}
}

// interjected is Events with an Interjector: the server's events are read on a goroutine and passed over a channel,
// so that the next of them and the interjector's due time can be waited on together.
func (s *Stream[E, F]) interjected(yield func(E, error) bool) {
	type item struct {
		ev  E
		err error
	}
	var zero E
	events := make(chan item)
	stop := make(chan struct{})
	pumped := make(chan struct{})
	go func() {
		defer close(pumped)
		defer close(events)
		for {
			ev, err := s.next()
			if errors.Is(err, io.EOF) {
				return
			}
			select {
			case events <- item{ev, err}:
			case <-stop:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	// Leaving the loop, however it ends, ends the reader before the stream is closed, so the two never meet.
	defer func() {
		close(stop)
		s.cancel()
		<-pumped
		s.Close()
	}()
	for {
		var due <-chan time.Time
		var timer *time.Timer
		if at, ok := s.inter.Due(); ok {
			timer = time.NewTimer(time.Until(at))
			due = timer.C
		}
		var ev E
		var it item
		var fired, open bool
		select {
		case it, open = <-events:
		case <-due:
			fired = true
		}
		if timer != nil {
			timer.Stop()
		}
		switch {
		case fired:
			var err error
			if ev, err = s.inter.Fire(s.ctx); err != nil {
				yield(zero, err)
				return
			}
		case !open:
			return
		case it.err != nil:
			yield(zero, it.err)
			return
		default:
			var err error
			if ev, err = s.inter.See(s.ctx, it.ev); err != nil {
				yield(zero, err)
				return
			}
		}
		if !yield(ev, nil) {
			return
		}
	}
}

// FinalMessage drains the stream if needed (after a break too), returns the final event's member and closes
// the stream.
func (s *Stream[E, F]) FinalMessage() (*F, error) {
	// Drained or failed, the stream is done: its connection closes either way
	defer s.Close()
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
			// A clean end is the end of a stream that has its final event, or that cannot resume and has none.
			// Otherwise it reconnects: a proxy cut it short of its final event, or a server shutting down ended a
			// watch (PROTOCOL.md 5.6, 5.7).
			if clean && (s.final != nil || (s.spec.Resume == nil && s.spec.Final == nil)) {
				s.Close()
				return zero, io.EOF
			}
			if s.spec.Resume == nil {
				if clean {
					return zero, s.fail(sdkError("NO_FINAL_EVENT", "The stream ended without its final event", nil))
				}
				return zero, s.fail(err)
			}
			cause := err
			if clean {
				cause = nil // io.EOF as the cause would make STREAM_LOST look like the end of the stream to Events
			}
			if rerr := s.reconnect(cause); rerr != nil {
				return zero, s.fail(rerr)
			}
			continue
		}
		first := s.onConnection == 0
		s.onConnection++
		if name == "snapshot" {
			s.snapshotted = true
		}
		if id != "" {
			if _, dup := s.seen[id]; dup {
				continue
			}
			s.seen[id] = struct{}{}
			s.lastID = id
			// Only a new event counts as progress (PROTOCOL.md 5.6). An event without an id cannot be told apart from
			// a replay, so it does not count; every event on the conversation and workspace streams has one.
			if _, old := s.ever[id]; !old {
				s.ever[id] = struct{}{}
				if !(s.spec.Fresh && first) {
					s.attempts = 0
				}
			}
		}
		if name == "" {
			name = "message"
		}
		ev, ok, derr := s.spec.Decode(name, id, data)
		if derr != nil {
			var api *APIError
			if !errors.As(derr, &api) {
				derr = sdkError("DECODE_FAILED", "The "+name+" event could not be decoded", derr)
			}
			return zero, s.fail(derr)
		}
		if !ok {
			continue
		}
		if s.spec.Final != nil {
			if f, isFinal := s.spec.Final(ev); isFinal {
				s.final = f
				s.Close()
			} else if name == "stream.reset" && s.reconnects > 0 && !s.snapshotted {
				// A watch that began this connection with a snapshot (an unattended run's) carries on instead: its
				// final event is still to come, after the snapshot, even for a thing that had already ended.
				// PROTOCOL.md 5.9: the answer finished while the stream was disconnected, and its final event went
				// to the earlier connection. The stream ends at the reset, with no error and no further reconnect.
				s.Close()
			}
		}
		return ev, nil
	}
}

// reconnect re-attaches with Last-Event-ID, at most maxReconnects times in a row without an event (PROTOCOL.md 5.6).
func (s *Stream[E, F]) reconnect(cause error) error {
	if s.resp != nil {
		s.resp.Body.Close()
		s.resp = nil
	}
	// A connection that stayed open a minute or more starts the count again, like a new event: the server ends every
	// stream within an hour, and a quiet watch must outlive that (PROTOCOL.md 5.6).
	if !s.openedAt.IsZero() && StreamClock().Sub(s.openedAt) >= LongConnection {
		s.attempts = 0
	}
	s.openedAt = time.Time{}
	for {
		if s.attempts >= maxReconnects {
			return sdkError("STREAM_LOST", "The stream was lost and could not be resumed", cause)
		}
		s.reconnects++
		s.attempts++
		pause := time.NewTimer(ReconnectDelay(s.attempts))
		select {
		case <-s.ctx.Done():
			pause.Stop()
			return s.ctx.Err()
		case <-pause.C:
		}
		last := s.lastID
		if s.spec.Fresh {
			last = ""
		}
		resp, err := s.spec.Resume(s.ctx, last)
		if err == nil {
			s.attach(resp)
			if s.spec.Fresh {
				s.seen = map[string]struct{}{}
			}
			return nil
		}
		if s.ctx.Err() != nil {
			return s.ctx.Err()
		}
		// A thing that is gone stays gone: a 404 ends the stream with the 404 (PROTOCOL.md 16, wait.gone).
		var ae *APIError
		if errors.As(err, &ae) && ae.Status == 404 {
			return err
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
