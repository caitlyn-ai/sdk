package ui

import (
	"fmt"
	"image/color"
	"io"
	"math"
	"strings"
	"sync"
	"time"

	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
)

// SpinnerDelay is how long a call runs before its spinner shows, so fast commands show nothing (12.7).
var SpinnerDelay = 150 * time.Millisecond

// PlainProgressEvery is the most often a progress line is printed when stderr isn't a terminal (12.7).
const PlainProgressEvery = 10 * time.Second

// MotionAllowed reports whether spinners and progress bars may be drawn (12.7): stderr is a terminal, the run isn't
// in CI or agent mode, spinner = false isn't set, and CAITLYN_SPINNER_DISABLED isn't set.
func MotionAllowed(f *cmdutil.Factory) bool {
	if f == nil || !f.IO.IsStderrTTY() || !f.IO.Decorate || f.Agent.On || f.CI.In() || f.IO.Getenv("TERM") == "dumb" {
		return false
	}
	if v := strings.ToLower(f.IO.Getenv("CAITLYN_SPINNER_DISABLED")); v != "" && v != "0" && v != "false" {
		return false
	}
	if cfg, err := f.Config(); err == nil && cfg != nil {
		switch strings.ToLower(cfg.String("spinner")) {
		case "false", "0", "no", "off":
			return false
		}
	}
	return true
}

// Spinner is one line on stderr while something runs: `⠼ Planning the batch…` (12.7). It appears only after
// SpinnerDelay and only where MotionAllowed; otherwise every method does nothing.
type Spinner struct {
	u    *UI
	w    io.Writer
	mu   sync.Mutex
	text string
	// line is what is on screen now; "" while hidden.
	line    string
	stop    chan struct{}
	stopped chan struct{}
	once    sync.Once
}

// StartSpinner starts a spinner with a label. Stop it before printing the result.
func (u *UI) StartSpinner(f *cmdutil.Factory, label string) *Spinner {
	s := &Spinner{u: u, w: u.IO.ErrOut, text: label, stop: make(chan struct{}), stopped: make(chan struct{})}
	if !MotionAllowed(f) {
		close(s.stopped)
		return s
	}
	go s.run()
	return s
}

// frames is the bubbles spinner for the glyph set: the braille dots, or -\|/ in ASCII (12.5).
func (u *UI) frames() spinner.Spinner {
	return spinner.Spinner{Frames: u.G.Spinner, FPS: time.Second / 12}
}

func (s *Spinner) run() {
	defer close(s.stopped)
	select {
	case <-s.stop:
		return
	case <-time.After(SpinnerDelay):
	}
	frames := s.u.frames()
	m := spinner.New(spinner.WithSpinner(frames))
	t := time.NewTicker(frames.FPS)
	defer t.Stop()
	for {
		s.draw(m.View())
		select {
		case <-s.stop:
			return
		case <-t.C:
			m, _ = m.Update(m.Tick())
		}
	}
}

func (s *Spinner) draw(frame string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isStopping() {
		return
	}
	text := s.u.Truncate(s.text, s.u.IO.Width()-DisplayWidth(frame)-2)
	s.line = s.u.E(Accent, frame) + " " + text
	fmt.Fprint(s.w, "\r\x1b[K"+s.line)
}

func (s *Spinner) isStopping() bool {
	select {
	case <-s.stop:
		return true
	default:
		return false
	}
}

// SetLabel changes the label; the next frame shows it.
func (s *Spinner) SetLabel(label string) {
	s.mu.Lock()
	s.text = label
	s.mu.Unlock()
}

// Stop removes the spinner's line. The caller then prints the ✓ line that replaces it.
func (s *Spinner) Stop() {
	if s == nil {
		return
	}
	s.once.Do(func() { close(s.stop) })
	<-s.stopped
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.line != "" {
		fmt.Fprint(s.w, "\r\x1b[K")
		s.line = ""
	}
}

// Unit is what a progress bar counts.
type Unit int

// The units: items for processing, bytes for uploads (12.7).
const (
	Items Unit = iota
	Bytes
)

// Progress reports work with a known total (12.7). On a terminal it is a bar: amber fill, a rule-coloured track,
// then counts and the time left, never a bare percentage. Without one (or in CI) it is a plain line with a
// timestamp, at most one every PlainProgressEvery, so logs stay short.
type Progress struct {
	u       *UI
	w       io.Writer
	label   string
	unit    Unit
	total   int64
	tty     bool
	start   time.Time
	last    time.Time
	shown   bool
	Now     func() time.Time
	counted int64
	// ByteDone and ByteTotal add a byte count beside an item count ("6 of 10 · 11.2 of 18.4 MB"), for uploads.
	ByteDone, ByteTotal int64
}

// NewProgress starts reporting progress on stderr. In agent mode the caller decides whether to report at all
// (18.2: off unless --progress).
func (u *UI) NewProgress(f *cmdutil.Factory, label string, unit Unit, total int64) *Progress {
	p := &Progress{u: u, w: u.IO.ErrOut, label: label, unit: unit, total: total, tty: MotionAllowed(f), Now: time.Now}
	p.start = p.Now()
	return p
}

// Set reports how much is done.
func (p *Progress) Set(done int64) {
	p.counted = done
	now := p.Now()
	if p.tty {
		fmt.Fprint(p.w, "\r\x1b[K"+p.Bar(done, now.Sub(p.start)))
		p.shown = true
		return
	}
	if !p.last.IsZero() && now.Sub(p.last) < PlainProgressEvery && done < p.total {
		return
	}
	p.last = now
	fmt.Fprintln(p.w, p.Plain(done, now))
}

// Phase starts a new phase: on a terminal the bar's label changes; without one a line is printed straight away.
func (p *Progress) Phase(label string, total int64) {
	p.label, p.total, p.start, p.last = label, total, p.Now(), time.Time{}
	if !p.tty {
		fmt.Fprintln(p.w, p.Plain(0, p.start))
	}
}

// Finish removes the bar. The caller then prints its ✓ line.
func (p *Progress) Finish() {
	if p.tty && p.shown {
		fmt.Fprint(p.w, "\r\x1b[K")
		p.shown = false
	}
}

// Counts is "6 of 10", or "11.2 of 18.4 MB" for bytes.
func (p *Progress) Counts(done int64) string {
	if p.unit == Bytes {
		n, unit := scaleBytes(p.total)
		d, _ := scaleBytesTo(done, unit)
		return fmt.Sprintf("%s of %s %s", d, n, unit)
	}
	s := fmt.Sprintf("%d of %d", done, p.total)
	if p.ByteTotal > 0 {
		n, unit := scaleBytes(p.ByteTotal)
		d, _ := scaleBytesTo(p.ByteDone, unit)
		s += fmt.Sprintf(" %s %s of %s %s", p.u.G.Dot, d, n, unit)
	}
	return s
}

// Left is the estimate of time left, from the rate so far: "about 20 s left", or "" before there is a rate.
func (p *Progress) Left(done int64, took time.Duration) string {
	if done <= 0 || done >= p.total || took <= 0 {
		return ""
	}
	left := time.Duration(float64(took) / float64(done) * float64(p.total-done))
	return "about " + Duration(left.Round(time.Second)) + " left"
}

// Bar renders the terminal line: `  Uploading  ███████░░░  6 of 10 · 11.2 of 18.4 MB · about 20 s left`.
func (p *Progress) Bar(done int64, took time.Duration) string {
	dot := " " + p.u.G.Dot + " "
	tail := p.Counts(done)
	if left := p.Left(done, took); left != "" {
		tail += dot + left
	}
	width := p.u.IO.Width()
	barW := min(24, max(8, width-DisplayWidth(p.label)-DisplayWidth(tail)-8))
	full, empty := '█', '░'
	if !p.u.G.Unicode {
		full, empty = '#', '-'
	}
	m := progress.New(progress.WithWidth(barW), progress.WithoutPercentage(), progress.WithFillCharacters(full, empty))
	m.FullColor, m.EmptyColor = p.u.barColours()
	pct := 0.0
	if p.total > 0 {
		pct = float64(done) / float64(p.total)
	}
	return "  " + p.label + "  " + m.ViewAs(pct) + "  " + p.u.E(Muted, tail)
}

// Plain renders a line for logs: `2026-11-25T01:02:03Z Uploading: 6 of 10 (60%)`.
func (p *Progress) Plain(done int64, now time.Time) string {
	pct := ""
	if p.total > 0 {
		pct = fmt.Sprintf(" (%d%%)", int(math.Floor(float64(done)*100/float64(p.total))))
	}
	return now.UTC().Format(time.RFC3339) + " " + p.label + ": " + p.Counts(done) + pct
}

// barColours: the fill in the accent (a fill, so amber on light backgrounds too) and the track in the rule colour;
// none without colour.
func (u *UI) barColours() (full, empty color.Color) {
	a, ok := u.Err.(ANSIStyler)
	if !ok || !a.Colourful() {
		return nil, nil
	}
	full = a.rgb(0xff, 0xbb, 0x26, 214, ansiBrightYellow)
	if a.Background == "light" {
		empty = a.rgb(0xd9, 0xd5, 0xd3, 253, ansiBrightBlack)
	} else {
		empty = a.rgb(0x2e, 0x33, 0x31, 236, ansiBrightBlack)
	}
	return full, empty
}

// Duration writes a duration the way the CLI's screens do: "0.8 s", "24 s", "1 m 52 s", "2 h 5 m".
func Duration(d time.Duration) string {
	switch {
	case d < 10*time.Second:
		s := fmt.Sprintf("%.1f s", d.Seconds())
		return strings.Replace(s, ".0 s", " s", 1)
	case d < time.Minute:
		return fmt.Sprintf("%d s", int(d.Round(time.Second).Seconds()))
	case d < time.Hour:
		d = d.Round(time.Second)
		m, s := int(d.Minutes()), int(d.Seconds())%60
		if s == 0 {
			return fmt.Sprintf("%d m", m)
		}
		return fmt.Sprintf("%d m %d s", m, s)
	}
	d = d.Round(time.Minute)
	h, m := int(d.Hours()), int(d.Minutes())%60
	if m == 0 {
		return fmt.Sprintf("%d h", h)
	}
	return fmt.Sprintf("%d h %d m", h, m)
}

var byteUnits = []string{"B", "KB", "MB", "GB", "TB"}

// scaleBytes picks a decimal unit for n bytes: "18.4", "MB".
func scaleBytes(n int64) (string, string) {
	i := 0
	v := float64(n)
	for v >= 1000 && i < len(byteUnits)-1 {
		v /= 1000
		i++
	}
	return formatScaled(v, i), byteUnits[i]
}

func scaleBytesTo(n int64, unit string) (string, string) {
	v := float64(n)
	i := 0
	for byteUnits[i] != unit {
		v /= 1000
		i++
	}
	return formatScaled(v, i), unit
}

func formatScaled(v float64, unit int) string {
	if unit == 0 {
		return fmt.Sprintf("%d", int64(v))
	}
	return fmt.Sprintf("%.1f", v)
}

// FormatBytes writes a byte count: "18.4 MB".
func FormatBytes(n int64) string {
	v, u := scaleBytes(n)
	return v + " " + u
}

// TimedColumn is where SuccessTimed right-aligns its time, on terminals at least this wide.
const TimedColumn = 64

// SuccessTimed prints a ✓ line on stderr with how long the step took, muted and right-aligned (12.10):
// `✓ Uploaded 10 files (18.4 MB)                            24 s`.
func (u *UI) SuccessTimed(text string, took time.Duration) {
	t := Duration(took)
	head := u.G.Success + " " + text
	at := min(u.IO.Width(), TimedColumn)
	gap := max(2, at-DisplayWidth(head)-DisplayWidth(t))
	fmt.Fprintf(u.IO.ErrOut, "%s %s%s%s\n", u.E(Success, u.G.Success), text, strings.Repeat(" ", gap), u.E(Muted, t))
}
