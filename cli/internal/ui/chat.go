package ui

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
)

// ChatStream renders an agent's answer as it streams (12.8).
//
// On a terminal the answer is rendered as Markdown a block at a time: a paragraph, list or code block is rendered
// by glamour when it closes (a blank line, or the end of a fence), and the open block shows as plain text until
// then. Under it, on stderr, one status line shows the spinner and the latest progress label; it goes when the
// message completes. Without a terminal the deltas are written as they come: raw Markdown.
type ChatStream struct {
	u      *UI
	out    io.Writer
	errw   io.Writer
	tty    bool
	status bool

	mu sync.Mutex
	// pending is text not yet rendered: the open block.
	pending string
	// live is how many rows the open block and status line take on screen.
	live    int
	label   string
	frame   int
	printed bool

	stop chan struct{}
	done chan struct{}
}

// ChatTick is how often the status line's spinner moves. Tests set it to 0 to keep frames still.
var ChatTick = time.Second / 12

// NewChatStream starts rendering an answer.
func (u *UI) NewChatStream(f *cmdutil.Factory) *ChatStream {
	c := &ChatStream{u: u, out: u.IO.Out, errw: u.IO.ErrOut, tty: u.IO.IsStdoutTTY(), stop: make(chan struct{}), done: make(chan struct{})}
	c.status = c.tty && MotionAllowed(f)
	if c.status && ChatTick > 0 {
		go c.animate()
	} else {
		close(c.done)
	}
	return c
}

func (c *ChatStream) animate() {
	defer close(c.done)
	t := time.NewTicker(ChatTick)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
			c.mu.Lock()
			c.frame++
			if c.live > 0 && c.label != "" {
				fmt.Fprint(c.errw, "\r\x1b[K"+c.statusLine())
			}
			c.mu.Unlock()
		}
	}
}

// Status sets the status line's label (the latest progress.updated label): `› Searching HR policies`.
func (c *ChatStream) Status(label string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.label = label
	if c.status {
		c.erase()
		c.drawLive()
	}
}

// Write adds a text delta.
func (c *ChatStream) Write(delta string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.tty {
		io.WriteString(c.out, delta)
		return
	}
	c.erase()
	c.pending += delta
	if closed, open := splitClosedBlocks(c.pending); closed != "" {
		c.emit(closed)
		c.pending = open
	}
	c.drawLive()
}

// Finish renders what is left, removes the status line, and prints the sources and the footer: the conversation,
// the version that answered, and the command to continue (muted).
func (c *ChatStream) Finish(sources []Source, footer, next string) {
	select {
	case <-c.stop:
	default:
		close(c.stop)
	}
	<-c.done
	c.mu.Lock()
	defer c.mu.Unlock()
	u := c.u
	if !c.tty {
		if !strings.HasSuffix(c.pending, "\n") {
			io.WriteString(c.out, "\n")
		}
		if s := u.Sources(sources, false); s != "" {
			fmt.Fprint(c.out, "\n"+s)
		}
		if footer != "" {
			fmt.Fprintln(c.errw, footer)
		}
		if next != "" {
			fmt.Fprintln(c.errw, "-> "+next)
		}
		return
	}
	c.erase()
	if strings.TrimSpace(c.pending) != "" {
		c.emit(c.pending)
	}
	c.pending = ""
	if s := u.Sources(sources, true); s != "" {
		fmt.Fprint(c.out, "\n"+s)
	}
	if footer != "" || next != "" {
		fmt.Fprintln(c.out)
	}
	if footer != "" {
		fmt.Fprintln(c.out, u.S(Muted, footer))
	}
	if next != "" {
		fmt.Fprintln(c.out, u.S(Muted, u.G.Next+" "+next))
	}
}

// emit prints closed blocks for good, rendered, with a blank line between blocks.
func (c *ChatStream) emit(md string) {
	r := c.u.renderMarkdown(md, c.u.IO.ProseWidth())
	if r == "" {
		return
	}
	if c.printed {
		fmt.Fprintln(c.out)
	}
	fmt.Fprintln(c.out, r)
	c.printed = true
}

// erase removes the live region: back to its first row, then clear to the end of the screen.
func (c *ChatStream) erase() {
	if c.live == 0 {
		return
	}
	seq := "\r"
	if c.live > 1 {
		seq += fmt.Sprintf("\x1b[%dA", c.live-1)
	}
	fmt.Fprint(c.out, seq+"\x1b[J")
	c.live = 0
}

// drawLive writes the open block as plain text and, under it on stderr, the status line. The cursor ends on the
// region's last row.
func (c *ChatStream) drawLive() {
	open := strings.TrimLeft(c.pending, "\n")
	if open != "" && c.printed {
		// keep the blank line that will separate it from the block above once rendered
		open = "\n" + open
	}
	text := open
	if c.status && c.label != "" {
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		io.WriteString(c.out, text)
		fmt.Fprint(c.errw, c.statusLine())
		text += "x"
	} else {
		io.WriteString(c.out, text)
	}
	if text == "" {
		c.live = 0
		return
	}
	c.live = rows(text, c.u.IO.Width())
}

func (c *ChatStream) statusLine() string {
	u := c.u
	frames := u.G.Spinner
	frame := frames[c.frame%len(frames)]
	label := u.Truncate(c.label, u.IO.Width()-DisplayWidth(frame)-DisplayWidth(u.G.Marker)-3)
	return u.E(Accent, frame) + " " + u.E(Marker, u.G.Marker) + " " + label
}

// rows is how many terminal rows text takes at a width, counting wrapped lines.
func rows(text string, width int) int {
	if width <= 0 {
		width = 80
	}
	n := 0
	for _, l := range strings.Split(text, "\n") {
		w := DisplayWidth(l)
		n += max(1, (w+width-1)/width)
	}
	return n
}

// splitClosedBlocks splits Markdown into the blocks that have closed (ending at a blank line outside a code fence, or
// at a fence's closing line) and the open block after them.
func splitClosedBlocks(md string) (closed, open string) {
	cut := 0
	inFence := false
	fence := ""
	pos := 0
	lines := strings.SplitAfter(md, "\n")
	for _, l := range lines {
		pos += len(l)
		if !strings.HasSuffix(l, "\n") {
			break // the last line is still being written
		}
		t := strings.TrimSpace(l)
		switch {
		case inFence:
			if strings.HasPrefix(t, fence) {
				inFence = false
				cut = pos
			}
		case strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~"):
			inFence, fence = true, t[:3]
		case t == "":
			cut = pos
		}
	}
	return md[:cut], md[cut:]
}
