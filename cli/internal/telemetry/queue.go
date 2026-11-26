package telemetry

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

// The queue's limits (9.1).
// PostTimeout is the flush's whole budget, for all its requests: 3 seconds. A variable only so the tests that wait it
// out can shorten it.
var PostTimeout = 3 * time.Second

const (
	// MaxQueueBytes caps the queue: the oldest events go first.
	MaxQueueBytes = 256 * 1024
	// MaxAge drops events older than a week.
	MaxAge = 7 * 24 * time.Hour
	// FlushCount and FlushAge start a background flush: 20 events, or the oldest a day old.
	FlushCount = 20
	FlushAge   = 24 * time.Hour
	// MaxBatchEvents and MaxBatchBytes cap one request, as the intake does (usage-event.schema.json's maxItems): a
	// bigger queue goes in several requests.
	MaxBatchEvents = 100
	MaxBatchBytes  = 64 * 1024
)

// Queue is ~/.caitlyn/telemetry: queue.jsonl (mode 0600), the install ID and whether the notice was shown.
type Queue struct {
	Dir string
	Now func() time.Time
	// Version is the CLI's, for the User-Agent and for a stop (410).
	Version string
}

func (q Queue) now() time.Time {
	if q.Now != nil {
		return q.Now()
	}
	return time.Now()
}

// Path is the queue file.
func (q Queue) Path() string { return filepath.Join(q.Dir, "queue.jsonl") }

func (q Queue) statePath() string { return filepath.Join(q.Dir, "state.json") }
func (q Queue) lockPath() string  { return filepath.Join(q.Dir, "flush.lock") }

// locked runs fn holding queue.lock, so rewriting the queue (Append's prune, Flush taking it and putting events back)
// never loses another process's write.
func (q Queue) locked(fn func() error) error {
	if err := os.MkdirAll(q.Dir, 0o700); err != nil {
		return err
	}
	l := flock.New(filepath.Join(q.Dir, "queue.lock"))
	if err := l.Lock(); err != nil {
		return err
	}
	defer func() { _ = l.Unlock() }()
	return fn()
}

// State is what the CLI remembers about telemetry between runs.
type State struct {
	InstallID   string    `json:"install_id"`
	NoticeShown time.Time `json:"notice_shown,omitzero"`
	// Stopped is the endpoint that answered 410 Gone, and the CLI version it answered: that version queues and sends
	// nothing more to that endpoint. Another version, or another endpoint, isn't affected; caitlyn telemetry on clears
	// it.
	Stopped *Stop `json:"stopped,omitempty"`
	// RetryAfter is, per endpoint, when it may be sent to again: it answered 429 or 503 with Retry-After.
	RetryAfter map[string]time.Time `json:"retry_after,omitempty"`
}

// Stop records a 410.
type Stop struct {
	Version  string    `json:"version"`
	Endpoint string    `json:"endpoint"`
	At       time.Time `json:"at"`
}

// MaxRetryAfter caps how long a Retry-After keeps the CLI from sending.
const MaxRetryAfter = time.Hour

// Gone reports whether endpoint told this CLI version to stop sending (410).
func (q Queue) Gone(endpoint string) bool {
	st := q.LoadState().Stopped
	return st != nil && st.Version == q.Version && st.Endpoint == endpoint
}

// WaitUntil is when endpoint may be sent to again, or the zero time when it may now.
func (q Queue) WaitUntil(endpoint string) time.Time {
	if t, ok := q.LoadState().RetryAfter[endpoint]; ok && q.now().Before(t) {
		return t
	}
	return time.Time{}
}

// ClearStop forgets a 410 and any Retry-After: caitlyn telemetry on starts sending again.
func (q Queue) ClearStop() error {
	st := q.LoadState()
	if st.Stopped == nil && len(st.RetryAfter) == 0 {
		return nil
	}
	st.Stopped, st.RetryAfter = nil, nil
	return q.SaveState(st)
}

// LoadState reads the state; a missing or broken file is an empty state.
func (q Queue) LoadState() State {
	var s State
	if b, err := os.ReadFile(q.statePath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

// SaveState writes it (mode 0600).
func (q Queue) SaveState(s State) error {
	if err := os.MkdirAll(q.Dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(s)
	return writeAtomic(q.statePath(), b)
}

// InstallID returns the install ID, making one on first use.
func (q Queue) InstallID() (string, error) {
	s := q.LoadState()
	if s.InstallID != "" {
		return s.InstallID, nil
	}
	s.InstallID = NewUUID()
	return s.InstallID, q.SaveState(s)
}

// Reset makes a new install ID and deletes the queue, so nothing queued links the old ID to the new one.
func (q Queue) Reset() (string, error) {
	s := q.LoadState()
	s.InstallID = NewUUID()
	if err := q.SaveState(s); err != nil {
		return "", err
	}
	return s.InstallID, q.Delete()
}

// Delete removes the queue, and any batch a flush was sending.
func (q Queue) Delete() error {
	err := os.Remove(q.Path())
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	matches, _ := filepath.Glob(filepath.Join(q.Dir, "queue.*.sending"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
	return err
}

func writeAtomic(path string, b []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func readEvents(path string) ([]Event, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseEvents(b), nil
}

func parseEvents(b []byte) []Event {
	var out []Event
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64*1024), MaxQueueBytes)
	for sc.Scan() {
		var e Event
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.EventID != "" {
			out = append(out, e)
		}
	}
	return out
}

func eventTime(e Event) time.Time {
	t, err := time.Parse(time.RFC3339, e.Time)
	if err != nil {
		return time.Time{}
	}
	return t
}

// Pending is what is queued, exactly as it would be sent.
func (q Queue) Pending() ([]Event, error) {
	evs, err := readEvents(q.Path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return evs, err
}

// encode is one event per line.
func encode(evs []Event) []byte {
	var b bytes.Buffer
	for _, e := range evs {
		line, _ := json.Marshal(e)
		b.Write(line)
		b.WriteByte('\n')
	}
	return b.Bytes()
}

// prune drops events older than a week, then the oldest until the rest fit in MaxQueueBytes.
func (q Queue) prune(evs []Event) []Event {
	cutoff := q.now().Add(-MaxAge)
	kept := evs[:0:0]
	for _, e := range evs {
		if t := eventTime(e); !t.IsZero() && t.Before(cutoff) {
			continue
		}
		kept = append(kept, e)
	}
	sort.SliceStable(kept, func(i, j int) bool { return eventTime(kept[i]).Before(eventTime(kept[j])) })
	sizes := make([]int, len(kept))
	total := 0
	for i, e := range kept {
		line, _ := json.Marshal(e)
		sizes[i] = len(line) + 1
		total += sizes[i]
	}
	drop := 0
	for drop < len(kept) && total > MaxQueueBytes {
		total -= sizes[drop]
		drop++
	}
	return kept[drop:]
}

// Append adds an event: one local write, and no network. It returns whether a flush is due.
func (q Queue) Append(e Event) (flushDue bool, err error) {
	err = q.locked(func() error {
		var aerr error
		flushDue, aerr = q.appendLocked(e)
		return aerr
	})
	return flushDue, err
}

func (q Queue) appendLocked(e Event) (flushDue bool, err error) {
	line, err := json.Marshal(e)
	if err != nil {
		return false, err
	}
	f, err := os.OpenFile(q.Path(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return false, err
	}
	_ = f.Chmod(0o600)
	_, werr := f.Write(append(line, '\n'))
	cerr := f.Close()
	if werr != nil {
		return false, werr
	}
	if cerr != nil {
		return false, cerr
	}
	b, err := os.ReadFile(q.Path())
	if err != nil {
		return false, err
	}
	evs := parseEvents(b)
	kept := q.prune(evs)
	if len(kept) != len(evs) || len(b) > MaxQueueBytes {
		if err := writeAtomic(q.Path(), encode(kept)); err != nil {
			return false, err
		}
	}
	if len(kept) >= FlushCount {
		return true, nil
	}
	if len(kept) > 0 {
		if t := eventTime(kept[0]); !t.IsZero() && q.now().Sub(t) >= FlushAge {
			return true, nil
		}
	}
	return false, nil
}

// ClaimSpawn reports whether this run should start a background flush, and records that it did: at most one
// starts a minute, so a burst of runs starts one, not dozens.
func (q Queue) ClaimSpawn() bool {
	if st, err := os.Stat(q.lockPath()); err == nil && q.now().Sub(st.ModTime()) < time.Minute {
		return false
	}
	if err := os.MkdirAll(q.Dir, 0o700); err != nil {
		return false
	}
	if err := os.WriteFile(q.lockPath(), nil, 0o600); err != nil {
		return false
	}
	now := q.now()
	_ = os.Chtimes(q.lockPath(), now, now)
	return true
}

// Batch is the request body: SchemaID and the events, as usage-event.schema.json describes.
type Batch struct {
	Schema string  `json:"schema"`
	Events []Event `json:"events"`
}

// SchemaID names the batch's version for the intake, which validates the body against usage-event.schema.json.
const SchemaID = "caitlyn-cli-usage/1"

// outcome is what an answer means for the batch it was sent with.
type outcome int

const (
	sent outcome = iota // 2xx: delete it
	drop                // 400, 413, 415: the intake will never take it, so delete it
	keep                // 429, 5xx, a network error, anything else: keep it for the next flush
	gone                // 410: delete the queue and stop sending
)

func classify(status int, err error) outcome {
	switch {
	case err != nil:
		return keep
	case status >= 200 && status <= 299:
		return sent
	case status == http.StatusBadRequest, status == http.StatusRequestEntityTooLarge, status == http.StatusUnsupportedMediaType:
		return drop
	case status == http.StatusGone:
		return gone
	}
	return keep
}

// batches splits events into requests of at most MaxBatchEvents events and MaxBatchBytes bytes of body each, in
// order, encoding each event once and counting the body's bytes as it goes. An event too big to send on its own
// (none can be, by the schema's limits) is left out.
func batches(evs []Event) [][]Event {
	// {"schema":"…","events":[ e1,e2 ]}: the fixed part, then each event and the commas between them
	empty, _ := json.Marshal(Batch{Schema: SchemaID, Events: []Event{}})
	fixed := len(empty)
	var out [][]Event
	var cur []Event
	size := fixed
	for _, e := range evs {
		b, _ := json.Marshal(e)
		add := len(b)
		if len(cur) > 0 {
			add++ // the comma
		}
		if len(cur) > 0 && (len(cur)+1 > MaxBatchEvents || size+add > MaxBatchBytes) {
			out = append(out, cur)
			cur, size, add = nil, fixed, len(b)
		}
		if fixed+len(b) > MaxBatchBytes {
			continue
		}
		cur = append(cur, e)
		size += add
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	return out
}

// Flush sends the queue, in requests of at most MaxBatchEvents events and MaxBatchBytes, all within PostTimeout,
// and stops. Each answer decides its batch: 2xx is sent, and 400, 413 and 415 are dropped (the intake will never
// take them); 429, 5xx and a network error keep it, and every batch after it, for the next flush, and a Retry-After
// on 429 or 503 keeps this endpoint from being sent to until it passes (at most MaxRetryAfter); 410 deletes this
// version's events and stops it sending to this endpoint, leaving other versions' events alone. The error is for
// tests and status, never shown after a command.
func (q Queue) Flush(ctx context.Context, endpoint string, client *http.Client) (int, error) {
	if endpoint == "" {
		return 0, errors.New("no telemetry endpoint")
	}
	if q.Gone(endpoint) {
		return 0, errors.New("the endpoint said this CLI version should stop sending (410)")
	}
	if until := q.WaitUntil(endpoint); !until.IsZero() {
		return 0, fmt.Errorf("the endpoint asked to wait until %s (Retry-After)", until.UTC().Format(time.RFC3339))
	}
	var files []string
	var evs []Event
	err := q.locked(func() error {
		// Take the queue: runs that end meanwhile start a new one. A batch left by a flush that died is taken too. The
		// taken file's time is now, not its last Append's, so a flush running at the same time leaves it alone.
		sending := filepath.Join(q.Dir, "queue."+NewUUID()[:8]+".sending")
		if err := os.Rename(q.Path(), sending); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		now := q.now()
		_ = os.Chtimes(sending, now, now)
		matches, _ := filepath.Glob(filepath.Join(q.Dir, "queue.*.sending"))
		for _, m := range matches {
			if m != sending {
				if st, err := os.Stat(m); err != nil || q.now().Sub(st.ModTime()) < time.Minute {
					continue // another flush is sending it
				}
			}
			if e, err := readEvents(m); err == nil {
				evs = append(evs, e...)
				files = append(files, m)
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	evs = q.prune(dedupe(evs))
	n := 0
	var kept []Event
	var last error
	stopped := false
	if len(evs) > 0 {
		pctx, cancel := context.WithTimeout(ctx, PostTimeout)
		defer cancel()
		all := batches(evs)
	send:
		for i, b := range all {
			status, wait, err := q.post(pctx, endpoint, client, b)
			switch classify(status, err) {
			case sent:
				n += len(b)
				continue
			case drop:
				last = fmt.Errorf("the telemetry endpoint refused a batch (%d); it was dropped", status)
				continue
			case gone:
				stopped = true
				last = errors.New("the telemetry endpoint is gone (410): this CLI version stops sending to it")
				// This version's events go; another version's stay, whatever the endpoint said to this one
				mine := EventVersion(q.Version)
				for _, r := range all[i:] {
					for _, e := range r {
						if e.Version != mine {
							kept = append(kept, e)
						}
					}
				}
				break send
			}
			// keep: this batch and the rest, for the next flush
			for _, r := range all[i:] {
				kept = append(kept, r...)
			}
			if err != nil {
				last = err
			} else {
				last = fmt.Errorf("the telemetry endpoint answered %d", status)
			}
			if wait > 0 {
				st := q.LoadState()
				if st.RetryAfter == nil {
					st.RetryAfter = map[string]time.Time{}
				}
				st.RetryAfter[endpoint] = q.now().Add(min(wait, MaxRetryAfter))
				_ = q.SaveState(st)
			}
			break
		}
	}
	err = q.locked(func() error {
		if stopped {
			st := q.LoadState()
			st.Stopped = &Stop{Version: q.Version, Endpoint: endpoint, At: q.now().UTC()}
			_ = q.SaveState(st)
			// and this version's events queued while it was sending: other versions' stay
			if b, rerr := os.ReadFile(q.Path()); rerr == nil {
				mine := EventVersion(q.Version)
				var others []Event
				for _, e := range parseEvents(b) {
					if e.Version != mine {
						others = append(others, e)
					}
				}
				_ = writeAtomic(q.Path(), encode(others))
			}
		}
		if len(kept) > 0 {
			f, oerr := os.OpenFile(q.Path(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			if oerr != nil {
				return oerr
			}
			_, _ = f.Write(encode(kept))
			_ = f.Close()
		}
		for _, f := range files {
			_ = os.Remove(f)
		}
		return nil
	})
	if err != nil && last == nil {
		last = err
	}
	return n, last
}

func dedupe(evs []Event) []Event {
	seen := map[string]bool{}
	out := evs[:0:0]
	for _, e := range evs {
		if !seen[e.EventID] {
			seen[e.EventID] = true
			out = append(out, e)
		}
	}
	return out
}

// post sends one batch and returns the answer's status, and the wait a 429 or 503 asked for with Retry-After. The
// body's SHA-256, in hex, goes in x-amz-content-sha256: the intake is a Lambda function URL behind CloudFront with
// origin access control, which signs the request with it.
func (q Queue) post(ctx context.Context, endpoint string, client *http.Client, evs []Event) (int, time.Duration, error) {
	if client == nil {
		client = &http.Client{}
	}
	body, _ := json.Marshal(Batch{Schema: SchemaID, Events: evs})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, 0, err
	}
	sum := sha256.Sum256(body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-amz-content-sha256", hex.EncodeToString(sum[:]))
	req.Header.Set("User-Agent", "caitlyn-cli/"+userAgentVersion(q.Version))
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	var wait time.Duration
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		wait = retryAfter(resp.Header.Get("Retry-After"), q.now())
	}
	return resp.StatusCode, wait, nil
}

// retryAfter reads a Retry-After header: seconds, or an HTTP date. Anything else, or a time already past, is no wait.
func retryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs > 0 {
			return time.Duration(secs) * time.Second
		}
		return 0
	}
	if t, err := http.ParseTime(v); err == nil && t.After(now) {
		return t.Sub(now)
	}
	return 0
}

// userAgentVersion is the version for the User-Agent, or "unknown" when it isn't one (a dev build's).
func userAgentVersion(v string) string {
	if versionPattern.MatchString(v) {
		return v
	}
	return "unknown"
}
