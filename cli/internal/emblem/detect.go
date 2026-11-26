// Package emblem draws the Caitlyn character emblem beside the first lines of the few screens that greet a person
// (the CLI design, section 19): the welcome screen, sign-in success, first run and `version --logo`. It is an inline
// image (Kitty graphics, iTerm2 inline images or Sixel) 6 rows high, or nothing: where the terminal can't show an
// image, or its background or cell size can't be known, the screen is text alone.
package emblem

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// Protocol is how the terminal shows images.
type Protocol int

// The protocols.
const (
	None Protocol = iota
	Kitty
	ITerm2
	Sixel
)

func (p Protocol) String() string { return [...]string{"none", "kitty", "iterm2", "sixel"}[p] }

// Support is what the terminal can show, and its cell size in pixels (0 when unknown).
type Support struct {
	Protocol     Protocol
	CellW, CellH int
}

// Probe is how detection reaches the terminal. Tests script it.
type Probe struct {
	Getenv func(string) string
	// Query asks the terminal; nil when it mustn't be asked (stdin isn't the terminal).
	Query ui.Querier
	// WinSize reads the terminal size ioctl: columns, rows and the pixel fields (0 when the terminal leaves them
	// empty).
	WinSize func() (cols, rows, xpix, ypix int, ok bool)
}

// FromEnv detects image support from the environment alone, with no query (19.2, step 1).
func FromEnv(getenv func(string) string) Protocol {
	switch {
	case getenv("KITTY_WINDOW_ID") != "", getenv("TERM") == "xterm-kitty", getenv("TERM_PROGRAM") == "ghostty":
		return Kitty
	case getenv("TERM_PROGRAM") == "iTerm.app", getenv("LC_TERMINAL") == "iTerm2":
		return ITerm2
	case getenv("TERM_PROGRAM") == "WezTerm":
		// WezTerm shows both; Kitty's protocol is the one that keeps the aspect ratio from rows alone
		return Kitty
	}
	return None
}

// KittyQuery is Kitty's graphics query: a 1×1 RGB image, query only (19.2, step 2).
const KittyQuery = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\"

// CellQueries ask for the cell size (CSI 16 t) and the text area in pixels (CSI 14 t).
const CellQueries = "\x1b[16t\x1b[14t"

var (
	kittyReply = regexp.MustCompile(`\x1b_Gi=31;[^\x1b]*\x1b\\`)
	da1Params  = regexp.MustCompile(`\x1b\[\?([0-9;]*)c`)
	cellReply  = regexp.MustCompile(`\x1b\[6;(\d+);(\d+)t`)
	areaReply  = regexp.MustCompile(`\x1b\[4;(\d+);(\d+)t`)
)

// MayQuery reports whether the terminal may be asked anything: never with TERM=dumb, inside tmux or screen, or when
// stdin isn't the terminal (no Querier).
func (p Probe) MayQuery() bool {
	return p.Query != nil && p.Getenv("TERM") != "dumb" && !ui.InMultiplexer(p.Getenv)
}

// Detect finds the protocol and the cell size (19.2): the environment first; then one query, sharing one 100 ms
// limit, for whatever is still unknown (Kitty's a=q, CSI 16 t and CSI 14 t), ended by DA1, which every terminal
// answers, so the read never waits out the limit on a terminal that answers.
func Detect(p Probe) Support {
	s := Support{Protocol: FromEnv(p.Getenv)}
	cols, rows := 0, 0
	if p.WinSize != nil {
		if c, r, xp, yp, ok := p.WinSize(); ok && c > 0 && r > 0 {
			cols, rows = c, r
			if xp > 0 && yp > 0 {
				s.CellW, s.CellH = xp/c, yp/r
			}
		}
	}
	if !p.MayQuery() {
		return s
	}
	q := ""
	if s.Protocol == None {
		q += KittyQuery
	}
	if s.CellW == 0 {
		q += CellQueries
	}
	if q == "" {
		return s
	}
	reply := p.Query.Query(q+ui.DA1, ui.HasDA1, ui.QueryLimit)
	if s.Protocol == None {
		s.Protocol = protocolFromReply(reply)
	}
	if s.CellW == 0 {
		s.CellW, s.CellH = cellFromReply(reply, cols, rows)
	}
	return s
}

// protocolFromReply: a graphics reply means Kitty; DA1 listing 4 means Sixel; DA1 alone means no images.
func protocolFromReply(reply []byte) Protocol {
	if kittyReply.Match(reply) {
		return Kitty
	}
	if m := da1Params.FindSubmatch(reply); m != nil {
		params := strings.Split(string(m[1]), ";")
		for _, v := range params[min(1, len(params)):] {
			if v == "4" {
				return Sixel
			}
		}
	}
	return None
}

// cellFromReply reads the cell size from CSI 16 t's reply, else from CSI 14 t's divided by the columns and rows.
func cellFromReply(reply []byte, cols, rows int) (int, int) {
	if m := cellReply.FindSubmatch(reply); m != nil {
		h, _ := strconv.Atoi(string(m[1]))
		w, _ := strconv.Atoi(string(m[2]))
		if w > 0 && h > 0 {
			return w, h
		}
	}
	if m := areaReply.FindSubmatch(reply); m != nil && cols > 0 && rows > 0 {
		h, _ := strconv.Atoi(string(m[1]))
		w, _ := strconv.Atoi(string(m[2]))
		if w/cols > 0 && h/rows > 0 {
			return w / cols, h / rows
		}
	}
	return 0, 0
}
