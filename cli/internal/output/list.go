package output

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"syscall"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
)

// Page is one page of a list, as the server sent it.
type Page struct {
	Raw   []byte
	Items []json.RawMessage
	Next  string
}

// Fetch reads the page after cursor ("" for the first).
type Fetch func(ctx context.Context, cursor string) (*Page, error)

// ListOptions are the list flags (4.3).
type ListOptions struct {
	All      bool
	MaxItems int
	Cursor   string
	// Shape is the items' shape, for table columns.
	Shape string
	// Noun is what the items are, for the footer and empty state ("documents").
	Noun string
	// Empty is the command that adds one, for the empty state.
	Empty string
}

// PagerHooks let the pager package take over stdout while a list is printed to a terminal (14.2). Start returns
// false when no pager is used; the list then prints its first page and offers more (MorePrompt).
var PagerHooks struct {
	Start      func(f *cmdutil.Factory) bool
	Stop       func(f *cmdutil.Factory)
	MorePrompt func(f *cmdutil.Factory, shown int) (more, all bool)
}

// SafetyCap is the most items a pager-driven list fetches without --all (14.2).
const SafetyCap = 10000

// List prints a list (4.3 and 14.2): the CLI fetches pages only as fast as someone reads them.
//
//   - JSON (piped, or asked for): the first page as the server sent it, {items, nextCursor}; with --all, every page as
//     one {"items": [...]} document, or as JSON Lines one item per line when the format is jsonl;
//   - a terminal with a pager: every page, fetched as the pager reads;
//   - a terminal without one: the first page, then "more".
func (p *Printer) List(ctx context.Context, fetch Fetch, o ListOptions) error {
	if p.Format == JSONL || (p.Format == JSON && o.All) || (p.Filtered() && o.All) {
		return p.listStream(ctx, fetch, o)
	}
	if p.Format == JSON || p.Format == YAML || p.Filtered() {
		page, err := fetch(ctx, o.Cursor)
		if err != nil {
			return err
		}
		if o.MaxItems > 0 && len(page.Items) > o.MaxItems {
			b, _ := json.Marshal(map[string]any{"items": page.Items[:o.MaxItems]})
			return p.Raw(b, "")
		}
		return p.Raw(page.Raw, "")
	}
	return p.listTable(ctx, fetch, o)
}

func (p *Printer) listStream(ctx context.Context, fetch Fetch, o ListOptions) error {
	var all []json.RawMessage
	cursor, n := o.Cursor, 0
	for {
		page, err := fetch(ctx, cursor)
		if err != nil {
			return err
		}
		for _, it := range page.Items {
			if o.MaxItems > 0 && n >= o.MaxItems {
				break
			}
			n++
			if p.Format == JSONL {
				if err := p.Raw(it, o.Shape); err != nil {
					return err
				}
			} else {
				all = append(all, it)
			}
		}
		if page.Next == "" || (o.MaxItems > 0 && n >= o.MaxItems) || (!o.All && p.Format == JSONL) {
			if !o.All && page.Next != "" && p.Format == JSONL {
				fmt.Fprintf(p.F.IO.ErrOut, "More: --all, or --cursor %s\n", page.Next)
			}
			break
		}
		cursor = page.Next
	}
	if p.Format == JSONL {
		return nil
	}
	if all == nil {
		all = []json.RawMessage{}
	}
	b, err := json.Marshal(map[string]any{"items": all})
	if err != nil {
		return err
	}
	return p.Raw(b, "")
}

func (p *Printer) listTable(ctx context.Context, fetch Fetch, o ListOptions) error {
	tty := p.F.IO.IsStdoutTTY()
	paged := tty && PagerHooks.Start != nil && PagerHooks.Start(p.F)
	if paged {
		defer PagerHooks.Stop(p.F)
	}
	cursor, shown := o.Cursor, 0
	var cols []string
	first := true
	for {
		page, err := fetch(ctx, cursor)
		if err != nil {
			return err
		}
		items := page.Items
		if o.MaxItems > 0 && shown+len(items) > o.MaxItems {
			items = items[:o.MaxItems-shown]
		}
		if first && len(items) == 0 {
			p.empty(o)
			return nil
		}
		if first {
			cols = p.Columns(o.Shape, items)
		}
		var buf strings.Builder
		rows := p.Rows(cols, items)
		if first || !tty {
			p.U.Table(&buf, tty, Headers(cols), rows, "")
		} else {
			// later pages keep the first page's columns: draw without the header
			var tmp strings.Builder
			p.U.Table(&tmp, tty, Headers(cols), rows, "")
			lines := strings.SplitN(tmp.String(), "\n", 3)
			if len(lines) == 3 {
				buf.WriteString(lines[2])
			}
		}
		if _, err := io.WriteString(p.out(), buf.String()); err != nil {
			if paged && isClosedPipe(err) {
				return nil // the person quit the pager: stop fetching, exit 0
			}
			return err
		}
		shown += len(items)
		first = false
		done := page.Next == "" || (o.MaxItems > 0 && shown >= o.MaxItems)
		if done {
			p.footer(shown, o, "")
			return nil
		}
		switch {
		case o.All:
		case paged:
			if shown >= SafetyCap {
				p.footer(shown, o, page.Next)
				return nil
			}
		case tty && PagerHooks.MorePrompt != nil && p.F.Interactive() && !p.F.Agent.On && !p.F.CI.In():
			more, all := PagerHooks.MorePrompt(p.F, shown)
			if !more {
				p.footer(shown, o, page.Next)
				return nil
			}
			if all {
				o.All = true
			}
		default:
			p.footer(shown, o, page.Next)
			return nil
		}
		cursor = page.Next
	}
}

func isClosedPipe(err error) bool {
	return errors.Is(err, syscall.EPIPE) || errors.Is(err, io.ErrClosedPipe) || strings.Contains(err.Error(), "broken pipe")
}

func (p *Printer) footer(shown int, o ListOptions, next string) {
	if !p.F.IO.IsStdoutTTY() {
		if next != "" {
			fmt.Fprintf(p.F.IO.ErrOut, "More: --all, or --cursor %s\n", next)
		}
		return
	}
	noun := o.Noun
	if noun == "" {
		noun = "items"
	}
	if shown == 1 {
		if strings.HasSuffix(noun, "ies") {
			noun = strings.TrimSuffix(noun, "ies") + "y"
		} else {
			noun = strings.TrimSuffix(noun, "s")
		}
	}
	line := fmt.Sprintf("%d %s", shown, noun)
	fmt.Fprintln(p.out())
	fmt.Fprintln(p.out(), p.U.S(ui.Muted, line))
	if next != "" {
		fmt.Fprintln(p.F.IO.ErrOut, p.U.E(ui.Muted, "More: --all, or --cursor "+next))
	}
}

func (p *Printer) empty(o ListOptions) {
	noun := o.Noun
	if noun == "" {
		noun = "items"
	}
	fmt.Fprintf(p.F.IO.ErrOut, "No %s yet.\n", noun)
	if o.Empty != "" {
		p.U.Nextf("Add one: %s", o.Empty)
	}
}
