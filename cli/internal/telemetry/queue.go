package telemetry

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The queue's limits (9.1).
const (
	// MaxQueueBytes caps the queue: the oldest events go first.
	MaxQueueBytes = 256 * 1024
	// MaxAge drops events older than a week.
	MaxAge = 7 * 24 * time.Hour
	// FlushCount and FlushAge start a background flush: 20 events, or the oldest a day old.
	FlushCount = 20
	FlushAge   = 24 * time.Hour
	// PostTimeout is the flush's whole budget for its one request.
	PostTimeout = 3 * time.Second
)

// Queue is ~/.caitlyn/telemetry: queue.jsonl (mode 0600), the install ID and whether the notice was shown.
type Queue struct {
	Dir string
	Now func() time.Time
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

// State is what the CLI remembers about telemetry between runs.
type State struct {
	InstallID   string    `json:"install_id"`
	NoticeShown time.Time `json:"notice_shown,omitzero"`
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
	if err := os.MkdirAll(q.Dir, 0o700); err != nil {
		return false, err
	}
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

// Batch is the request body.
type Batch struct {
	Events []Event `json:"events"`
}

// Flush sends the queue in one request with a 3-second limit, deletes what was accepted, and stops. Failures are
// kept for the next flush; the error is for tests and status, never shown after a command.
func (q Queue) Flush(ctx context.Context, endpoint string, client *http.Client) (int, error) {
	if endpoint == "" {
		return 0, errors.New("no telemetry endpoint")
	}
	// Take the queue: runs that end meanwhile start a new one. A batch left by a flush that died is taken too.
	sending := filepath.Join(q.Dir, "queue."+NewUUID()[:8]+".sending")
	if err := os.Rename(q.Path(), sending); err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	matches, _ := filepath.Glob(filepath.Join(q.Dir, "queue.*.sending"))
	var files []string
	var evs []Event
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
	evs = q.prune(dedupe(evs))
	if len(evs) == 0 {
		for _, f := range files {
			_ = os.Remove(f)
		}
		return 0, nil
	}
	err := post(ctx, endpoint, client, evs)
	if err != nil {
		// Put them back for the next flush.
		if f, oerr := os.OpenFile(q.Path(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); oerr == nil {
			_, _ = f.Write(encode(evs))
			_ = f.Close()
		}
	}
	for _, f := range files {
		_ = os.Remove(f)
	}
	if err != nil {
		return 0, err
	}
	return len(evs), nil
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

func post(ctx context.Context, endpoint string, client *http.Client, evs []Event) error {
	if client == nil {
		client = &http.Client{}
	}
	ctx, cancel := context.WithTimeout(ctx, PostTimeout)
	defer cancel()
	body, _ := json.Marshal(Batch{Events: evs})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return errors.New("the telemetry endpoint answered " + strings.TrimSpace(resp.Status))
	}
	return nil
}
