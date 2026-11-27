// Package hand holds the hand-written commands that compose several operations or work with local files (the CLI
// design, 2.5): chat, events tail, kb sync, document uploads, the draft as a file, and config as code.
package hand

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// MarkdownRenderer renders a closed block of an answer for a terminal; the design system replaces it with glamour.
var MarkdownRenderer = func(u *ui.UI, block string, width int) string { return block }

type chatOptions struct {
	conversation string
	attach       []string
	contextFile  string
	show         []string
	title        string
}

// NewChat returns `caitlyn chat` (6.3).
func NewChat(f *cmdutil.Factory) *cobra.Command {
	o := &chatOptions{}
	cmd := &cobra.Command{
		Use:   "chat [agent[@version]] [message]",
		Short: "Ask an agent a question and stream its cited answer",
		Long: `Starts a conversation with an agent (AGENT alone is its live version) and streams the answer, or continues
one with --conversation. The answer streams to stdout; progress shows on stderr; citations print as numbered
sources at the end. A message of - is read from stdin.

-o jsonl prints every event, for scripts and AI agents. Ctrl-C stops reading: the answer carries on in Caitlyn,
and the CLI prints the command that follows it.`,
		Example: `  caitlyn chat GHT7YRWXPL "How many days of annual leave do staff get?"
  caitlyn chat GHT7YRWXPL@draft "Does this match our policy?" --attach ./leave-form.pdf
  caitlyn chat --conversation 0193b1d4-5e2a-7c11-a9f0-2d6e8b4c7a10 "And for part-time staff?"
  git log -1 --format=%B | caitlyn chat REVIEWER01@draft - -o jsonl`,
		Args:        cobra.MaximumNArgs(2),
		Annotations: map[string]string{"impact": "write", "scope": "chat:write", "operation": "CreateConversation,SendMessage"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runChat(cmd.Context(), f, o, args)
		},
	}
	fl := cmd.Flags()
	fl.StringVar(&o.conversation, "conversation", "", "Continue this conversation")
	fl.StringArrayVar(&o.attach, "attach", nil, "Attach a file to the message (repeatable)")
	fl.StringVar(&o.contextFile, "context-file", "", "Structured context for the message: a JSON list of {type, label, uri, data} (at most 20 items, 16 KB)")
	fl.StringSliceVar(&o.show, "show", nil, "Also show: tools, quotes")
	fl.StringVar(&o.title, "title", "", "A title for a new conversation")
	return cmd
}

func runChat(ctx context.Context, f *cmdutil.Factory, o *chatOptions, args []string) error {
	cfg, err := f.Config()
	if err != nil {
		return err
	}
	u := gen.UIFor(f)
	p, err := output.NewStream(f, u)
	if err != nil {
		return err
	}
	agentArg, message := "", ""
	switch {
	case o.conversation != "" && len(args) == 2:
		return cmdutil.Usagef("with --conversation, give only the message")
	case o.conversation != "" && len(args) == 1:
		message = args[0]
	case len(args) == 2:
		agentArg, message = args[0], args[1]
	case len(args) == 1:
		agentArg = args[0]
	}
	if agentArg == "" && o.conversation == "" {
		agentArg = cfg.String("agent")
		if agentArg != "" && !strings.Contains(agentArg, "@") && cfg.String("version") != "" {
			agentArg += "@" + cfg.String("version")
		}
		if agentArg == "" {
			e := cmdutil.Usagef("Name an agent: caitlyn chat AGENT \"…\".")
			e.Hint = &cmdutil.Hint{Missing: []string{"<agent>"}}
			e.AddNext("caitlyn agents list", "find an agent")
			return e
		}
	}
	if message == "-" {
		b, err := io.ReadAll(f.IO.In)
		if err != nil {
			return err
		}
		message = strings.TrimRight(string(b), "\n")
	}
	_, tc, err := f.Clients(ctx)
	if err != nil {
		return err
	}
	var sendOpts []caitlyn.SendOption
	for _, a := range o.attach {
		if _, err := os.Stat(a); err != nil {
			return cmdutil.Usagef("%s can't be attached: %v", a, err)
		}
		sendOpts = append(sendOpts, caitlyn.WithAttachments(caitlyn.Path(a)))
	}
	if o.contextFile != "" {
		b, err := os.ReadFile(o.contextFile)
		if err != nil {
			return cmdutil.Usagef("%s could not be read: %v", o.contextFile, err)
		}
		var items []caitlyn.ContextItem
		if err := json.Unmarshal(b, &items); err != nil {
			return cmdutil.Usagef("%s is not a JSON list of context items: %v", o.contextFile, err)
		}
		sendOpts = append(sendOpts, caitlyn.WithMessageContext(items...))
	}
	c := &chat{f: f, u: u, p: p, tc: tc, opts: o, agent: agentArg}
	if o.conversation != "" {
		c.conv = tc.Conversation(o.conversation)
	}
	if message == "" {
		if !f.Interactive() || p.Format != output.Table {
			return cmdutil.Usagef("Give a message, or - to read it from stdin.")
		}
		return c.loop(ctx, sendOpts)
	}
	return c.send(ctx, message, sendOpts)
}

type chat struct {
	f     *cmdutil.Factory
	u     *ui.UI
	p     *output.Printer
	tc    *caitlyn.Client
	opts  *chatOptions
	agent string
	conv  *caitlyn.ConversationScope
	label string
}

// start makes the conversation on AGENT@version (2.2): AGENT alone is live, and an agent with no live version is a
// clear error with exit 6, never a guess.
func (c *chat) start(ctx context.Context) error {
	if c.conv != nil {
		return nil
	}
	id, version := gen.SplitCompact(c.agent)
	if version == "" {
		version = "live"
	}
	in := &caitlyn.CreateConversationInput{}
	if c.opts.title != "" {
		in.Title = &c.opts.title
	}
	a := c.tc.Agent(id)
	var created *caitlyn.CreatedConversation
	var err error
	switch version {
	case "live":
		created, err = a.Live().Conversations.Create(ctx, in)
	case "draft":
		created, err = a.Draft().Conversations.Create(ctx, in)
	default:
		created, err = a.Version(version).Conversations.Create(ctx, in)
	}
	if err != nil {
		var nf *caitlyn.NotFoundError
		if version == "live" && errors.As(err, &nf) {
			e := &cmdutil.Error{Exit: exitcode.NotFound, Code: "NO_LIVE_VERSION", Cause: err,
				Title:  fmt.Sprintf("Agent %s has no live version yet, or isn't shared with you.", id),
				Detail: fmt.Sprintf("Name a version: %s@draft or %s@<name>.", id, id)}
			e.AddNext(fmt.Sprintf("caitlyn chat %s@draft \"…\"", id), "talk to the draft")
			e.AddNext(fmt.Sprintf("caitlyn agents versions list --agent %s", id), "see its versions")
			return e
		}
		return err
	}
	c.conv = created.ConversationScope
	c.label = fmt.Sprintf("%s@%s", id, version)
	return nil
}

func (c *chat) send(ctx context.Context, message string, sendOpts []caitlyn.SendOption) error {
	if err := c.start(ctx); err != nil {
		return err
	}
	stream, err := c.conv.Send(ctx, message, sendOpts...)
	if err != nil {
		return err
	}
	defer stream.Close()
	human := c.p.Format == output.Table || c.p.Format == output.Text
	var r *answerRenderer
	if human {
		r = newAnswerRenderer(c.f, c.u, c.p.Format == output.Table && c.f.IO.IsStdoutTTY(), c.opts.show)
	}
	var final *caitlyn.Message
	for ev, err := range stream.Events() {
		if err != nil {
			if r != nil {
				r.stopStatus()
			}
			if ctx.Err() != nil {
				e := &cmdutil.Error{Exit: exitcode.Interrupted, Code: "INTERRUPTED", Title: "Stopped reading. The answer carries on in Caitlyn."}
				e.AddNext("caitlyn conversations watch "+c.conv.ID(), "follow it")
				return e
			}
			return err
		}
		if !human {
			if err := c.p.Event(ev.EventType(), ev.EventID(), rawOf(ev)); err != nil {
				return err
			}
			continue
		}
		if mc, ok := ev.(*caitlyn.MessageCompleted); ok {
			m := mc.Message
			final = &m
		}
		r.event(ev)
	}
	if !human {
		return nil
	}
	r.finish(final)
	if c.f.IO.IsStderrTTY() || c.f.IO.IsStdoutTTY() {
		footer := "conversation " + c.conv.ID()
		if c.label != "" {
			footer = c.label + " " + c.u.G.Dot + " " + footer
		}
		if final != nil && final.AgentVersion != nil {
			footer += " (answered by " + *final.AgentVersion + ")"
		}
		fmt.Fprintln(c.f.IO.ErrOut, c.u.E(ui.Muted, footer))
		c.u.Nextf("caitlyn chat --conversation %s \"…\"", c.conv.ID())
	}
	return nil
}

// rawOf is an event's data as received.
func rawOf(ev caitlyn.ConversationEvent) []byte {
	if r, ok := ev.(interface{ RawJSON() json.RawMessage }); ok {
		return r.RawJSON()
	}
	b, _ := json.Marshal(ev)
	return b
}

// loop is the interactive chat: one conversation, a prompt per message, /attach, /new and /quit.
func (c *chat) loop(ctx context.Context, sendOpts []caitlyn.SendOption) error {
	in := bufio.NewReader(c.f.IO.In)
	fmt.Fprintln(c.f.IO.ErrOut, c.u.E(ui.Muted, "Type a message. /attach <file>, /new, /quit."))
	var pending []caitlyn.SendOption
	for {
		fmt.Fprint(c.f.IO.ErrOut, c.u.E(ui.Marker, c.u.G.Marker)+" ")
		line, err := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if err != nil && line == "" {
			fmt.Fprintln(c.f.IO.ErrOut)
			return nil
		}
		switch {
		case line == "":
			continue
		case line == "/quit" || line == "/exit":
			return nil
		case line == "/new":
			c.conv = nil
			c.u.Infof("A new conversation starts with your next message.")
			continue
		case strings.HasPrefix(line, "/attach "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "/attach "))
			if _, err := os.Stat(path); err != nil {
				c.u.Warnf("%s can't be attached: %v", path, err)
				continue
			}
			pending = append(pending, caitlyn.WithAttachments(caitlyn.Path(path)))
			c.u.Infof("Attached %s to your next message.", path)
			continue
		}
		opts := append(append([]caitlyn.SendOption{}, sendOpts...), pending...)
		pending = nil
		if err := c.send(ctx, line, opts); err != nil {
			if ctx.Err() != nil {
				return err
			}
			gen.UIFor(c.f).RenderError(c.f.IO.ErrOut, cmdutil.FromError(err))
		}
		fmt.Fprintln(c.f.IO.ErrOut)
	}
}

// answerRenderer draws an answer as it streams (12.8): text to stdout a block at a time (rendered as Markdown on a
// terminal), a one-line status on stderr, citations as numbered sources at the end.
type answerRenderer struct {
	f         *cmdutil.Factory
	u         *ui.UI
	markdown  bool
	open      strings.Builder
	inFence   bool
	citations map[int32]caitlyn.Citation
	order     []int32
	showTools bool
	status    string
}

func newAnswerRenderer(f *cmdutil.Factory, u *ui.UI, markdown bool, show []string) *answerRenderer {
	r := &answerRenderer{f: f, u: u, markdown: markdown, citations: map[int32]caitlyn.Citation{}}
	for _, s := range show {
		if s == "tools" {
			r.showTools = true
		}
	}
	return r
}

func (r *answerRenderer) event(ev caitlyn.ConversationEvent) {
	switch e := ev.(type) {
	case *caitlyn.TextDelta:
		r.text(e.Delta)
	case *caitlyn.ProgressUpdated:
		r.setStatus(e.Label)
	case *caitlyn.PhaseChanged:
		r.setStatus(strings.ReplaceAll(e.Phase, "_", " "))
	case *caitlyn.CitationAdded:
		if _, ok := r.citations[e.Citation.Number]; !ok {
			r.order = append(r.order, e.Citation.Number)
		}
		r.citations[e.Citation.Number] = e.Citation
	case *caitlyn.ToolStarted:
		if r.showTools {
			r.flushStatusLine(fmt.Sprintf("%s tool %s", r.u.G.Next, toolName(e)))
		}
	case *caitlyn.InputRequested:
		r.flush(true)
		r.stopStatus()
		fmt.Fprintln(r.f.IO.ErrOut, r.u.E(ui.Warning, r.u.G.Warning)+" The agent is asking for details, which can't be answered in a terminal yet. Open the conversation in Caitlyn to answer.")
	}
}

func toolName(e *caitlyn.ToolStarted) string {
	var m map[string]any
	_ = json.Unmarshal(e.RawJSON(), &m)
	for _, k := range []string{"name", "tool", "label"} {
		if s, ok := m[k].(string); ok {
			return s
		}
	}
	return ""
}

// text appends a delta and prints every block it closes: a blank line, or the end of a code fence.
func (r *answerRenderer) text(delta string) {
	r.open.WriteString(delta)
	for {
		s := r.open.String()
		i := r.blockEnd(s)
		if i < 0 {
			break
		}
		r.print(s[:i])
		rest := s[i:]
		r.open.Reset()
		r.open.WriteString(strings.TrimLeft(rest, "\n"))
	}
	if !r.markdown {
		// not a terminal: stream as it comes, nothing to re-render
		s := r.open.String()
		if s != "" {
			fmt.Fprint(r.f.IO.Out, s)
			r.open.Reset()
		}
	}
}

func (r *answerRenderer) blockEnd(s string) int {
	if !r.markdown {
		return -1
	}
	lines := strings.SplitAfter(s, "\n")
	pos := 0
	for _, l := range lines {
		pos += len(l)
		if !strings.HasSuffix(l, "\n") {
			break
		}
		trimmed := strings.TrimSpace(l)
		if strings.HasPrefix(trimmed, "```") {
			if r.inFence {
				r.inFence = false
				return pos
			}
			r.inFence = true
			continue
		}
		if !r.inFence && trimmed == "" && pos > 1 {
			return pos
		}
	}
	return -1
}

func (r *answerRenderer) print(block string) {
	r.clearStatus()
	if r.markdown {
		fmt.Fprint(r.f.IO.Out, MarkdownRenderer(r.u, block, r.f.IO.ProseWidth()))
		if !strings.HasSuffix(block, "\n\n") {
			fmt.Fprintln(r.f.IO.Out)
		}
		return
	}
	fmt.Fprint(r.f.IO.Out, block)
}

func (r *answerRenderer) flush(final bool) {
	s := r.open.String()
	r.open.Reset()
	if s == "" {
		return
	}
	r.print(strings.TrimRight(s, "\n") + "\n")
}

func (r *answerRenderer) setStatus(s string) {
	if !r.f.IO.IsStderrTTY() || !r.f.IO.Decorate || s == "" {
		return
	}
	r.status = s
	fmt.Fprintf(r.f.IO.ErrOut, "\r\x1b[2K%s %s", r.u.E(ui.Marker, r.u.G.Marker), r.u.E(ui.Muted, s))
}

func (r *answerRenderer) flushStatusLine(s string) {
	r.clearStatus()
	fmt.Fprintln(r.f.IO.ErrOut, r.u.E(ui.Muted, s))
}

func (r *answerRenderer) clearStatus() {
	if r.status != "" {
		fmt.Fprint(r.f.IO.ErrOut, "\r\x1b[2K")
		r.status = ""
	}
}

func (r *answerRenderer) stopStatus() { r.clearStatus() }

// finish prints what's left of the answer, then the sources.
func (r *answerRenderer) finish(m *caitlyn.Message) {
	r.flush(true)
	r.clearStatus()
	if m != nil {
		for _, c := range m.Citations {
			if _, ok := r.citations[c.Number]; !ok {
				r.order = append(r.order, c.Number)
			}
			r.citations[c.Number] = c
		}
	}
	if !r.markdown {
		fmt.Fprintln(r.f.IO.Out)
	}
	if len(r.order) == 0 {
		return
	}
	w := r.f.IO.Out
	fmt.Fprintln(w)
	if r.markdown {
		fmt.Fprintln(w, r.u.S(ui.Strong, "Sources"))
	} else {
		fmt.Fprintln(w, "Sources:")
		fmt.Fprintln(w)
	}
	for _, n := range r.order {
		c := r.citations[n]
		name := "a document"
		if c.DocumentName != nil {
			name = *c.DocumentName
		}
		if c.PageNumber != nil {
			name += fmt.Sprintf(", page %d", *c.PageNumber)
		}
		if r.markdown {
			fmt.Fprintf(w, "  %s %s\n", r.u.S(ui.Marker, fmt.Sprintf("[%d]", n)), name)
		} else {
			fmt.Fprintf(w, "- [%d] %s\n", n, name)
		}
	}
	fmt.Fprintln(w)
}
