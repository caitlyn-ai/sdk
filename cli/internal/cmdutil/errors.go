package cmdutil

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/go/core"
)

// Error is every failure the CLI reports: what happened (Title), why (Detail), how to fix it (Hint), and the exit
// code. Rendered for a person at a terminal, or as problem details with exitCode and hint for scripts, CI and AI
// agents (the CLI design, 4.5 and 18.2). --output shapes a command's data, never its errors.
type Error struct {
	Exit   int
	Title  string
	Detail string
	// Problem details, when the error came from Caitlyn (or the SDK).
	Type      string
	Status    int
	Code      string
	RequestID string
	Fields    []FieldProblem
	Hint      *Hint
	Cause     error
	// Silent errors print nothing (the command already said what happened); only the exit code is kept.
	Silent bool
	// Human is what a person at a terminal sees in place of, or as well as, the machine form. JSON never carries it,
	// so the problem details scripts and AI agents read stay as they are.
	Human *HumanForm
}

// HumanForm is the part of an error only a person reads: a shorter title, the commands they may have meant, the
// command's usage, and next steps that suit a person (caitlyn ai help rather than caitlyn commands --output json).
type HumanForm struct {
	Title       string
	Suggestions []string
	Usage       []string
	Hint        *Hint
}

// ForPeople is the error as a person at a terminal reads it: the human form's title and hint in place of the
// machine form's, and a next step of `caitlyn commands --output json` as plain `caitlyn commands`.
func (e *Error) ForPeople() *Error {
	p := *e
	h := e.Human
	if h == nil {
		h = &HumanForm{}
	}
	if h.Title != "" {
		p.Title = h.Title
	}
	hint := h.Hint
	if hint == nil && e.Hint != nil {
		c := *e.Hint
		c.Next = make([]NextStep, len(e.Hint.Next))
		for i, n := range e.Hint.Next {
			if n.Run == "caitlyn commands --output json" || n.Run == "caitlyn commands --json" {
				n.Run = "caitlyn commands"
			}
			c.Next[i] = n
		}
		hint = &c
	}
	p.Hint = hint
	return &p
}

// FieldProblem is one field error, named by the flag that set it when the CLI knows it.
type FieldProblem struct {
	Pointer string `json:"pointer,omitempty"`
	Flag    string `json:"flag,omitempty"`
	Detail  string `json:"detail"`
	Code    string `json:"code,omitempty"`
}

// Hint is what to do next: the flags that are missing, complete commands to run, and the docs page.
type Hint struct {
	Missing []string   `json:"missing,omitempty"`
	Next    []NextStep `json:"next,omitempty"`
	Docs    string     `json:"docs,omitempty"`
}

// NextStep is one command to run, and why.
type NextStep struct {
	Run string `json:"run"`
	Why string `json:"why"`
}

func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString(e.Title)
	if e.Code != "" {
		fmt.Fprintf(&b, " (%s)", e.Code)
	}
	if e.Detail != "" && e.Detail != e.Title {
		b.WriteString(": ")
		b.WriteString(e.Detail)
	}
	return b.String()
}

func (e *Error) Unwrap() error { return e.Cause }

// AddNext appends a next step.
func (e *Error) AddNext(run, why string) *Error {
	if e.Hint == nil {
		e.Hint = &Hint{}
	}
	e.Hint.Next = append(e.Hint.Next, NextStep{Run: run, Why: why})
	return e
}

// Usagef is a usage error (exit 2): bad flags or arguments, nothing sent.
func Usagef(format string, args ...any) *Error {
	return &Error{Exit: exitcode.Usage, Title: fmt.Sprintf(format, args...), Code: "USAGE"}
}

// ActionNeeded is exit 3: a question needs an answer and there's no one to ask. flag names the flag that answers it.
func ActionNeeded(what, flag string) *Error {
	e := &Error{Exit: exitcode.ActionNeeded, Title: what, Code: "CONFIRMATION_REQUIRED"}
	if flag != "" {
		e.Hint = &Hint{Missing: []string{flag}}
	}
	return e
}

// Forbiddenf is exit 5: not allowed, decided by the CLI before anything was sent.
func Forbiddenf(code, format string, args ...any) *Error {
	return &Error{Exit: exitcode.Forbidden, Title: fmt.Sprintf(format, args...), Code: code}
}

// Silent is an error that has already been reported; only its exit code matters.
func Silent(code int) *Error { return &Error{Exit: code, Silent: true} }

// ErrorType is the error's page on build.caitlyn.ai.
func ErrorType(code string) string {
	return "https://build.caitlyn.ai/errors/" + url.PathEscape(code)
}

// FromError turns any error into an *Error with the right exit code. SDK errors keep their problem details.
func FromError(err error) *Error {
	if err == nil {
		return nil
	}
	var ce *Error
	if errors.As(err, &ce) {
		return ce
	}
	if errors.Is(err, context.Canceled) {
		return &Error{Exit: exitcode.Interrupted, Title: "Interrupted.", Code: "INTERRUPTED", Cause: err}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &Error{Exit: exitcode.Timeout, Title: "Timed out.", Code: "TIMEOUT", Cause: err}
	}
	var ns *core.NotSupportedByServerError
	if errors.As(err, &ns) {
		what := ns.Operation
		if ns.Member != "" {
			what += "." + ns.Member
		}
		return &Error{Exit: exitcode.NotSupported, Code: "NOT_SUPPORTED_BY_SERVER", Cause: err,
			Title:  fmt.Sprintf("%s needs Caitlyn %s; this workspace runs %s.", what, ns.Requires, ns.Server),
			Detail: "This command is newer than your workspace's release. Ask your administrator when it will be updated."}
	}
	var in *core.InputError
	if errors.As(err, &in) {
		return &Error{Exit: exitcode.Usage, Code: "USAGE", Cause: err, Title: fmt.Sprintf("%s %s.", in.Member, in.Reason)}
	}
	var ae *core.AuthError
	if errors.As(err, &ae) {
		e := &Error{Exit: exitcode.Auth, Code: ae.Code, Title: "Not signed in, or the sign-in was refused.", Detail: ae.Message,
			RequestID: ae.RequestID, Cause: err}
		e.AddNext("caitlyn auth login", "sign in again")
		return e
	}
	var api *core.APIError
	if errors.As(err, &api) {
		e := &Error{Status: api.Status, Code: api.Code, Title: api.Title, Detail: api.Detail, Type: api.Type,
			RequestID: api.RequestID, Cause: err}
		if e.Title == "" {
			e.Title = strings.TrimPrefix(api.Error(), "caitlyn: ")
		}
		if e.Type == "" && api.Code != "" {
			e.Type = ErrorType(api.Code)
		}
		for _, f := range api.Errors {
			e.Fields = append(e.Fields, FieldProblem{Pointer: f.Pointer, Detail: f.Detail, Code: f.Code})
		}
		if c, ok := exitcode.ForCode(api.Code); ok {
			e.Exit = c
		} else if api.Status != 0 {
			e.Exit = exitcode.ForStatus(api.Status)
		} else {
			e.Exit = exitcode.Failed
		}
		return e
	}
	return &Error{Exit: exitcode.Failed, Title: err.Error(), Cause: err}
}

// JSON is the error as the machine-readable form prints it: problem details with exitCode and hint.
func (e *Error) JSON() map[string]any {
	p := map[string]any{"exitCode": e.Exit}
	if e.Type != "" {
		p["type"] = e.Type
	} else if e.Code != "" {
		p["type"] = ErrorType(e.Code)
	}
	if e.Title != "" {
		p["title"] = e.Title
	}
	if e.Status != 0 {
		p["status"] = e.Status
	}
	if e.Code != "" {
		p["code"] = e.Code
	}
	if e.Detail != "" {
		p["detail"] = e.Detail
	}
	if e.RequestID != "" {
		p["requestId"] = e.RequestID
	}
	if len(e.Fields) > 0 {
		p["errors"] = e.Fields
	}
	if e.Hint != nil {
		p["hint"] = e.Hint
	}
	return map[string]any{"error": p}
}
