// Package prompt asks people questions on the terminal. It never reads stdin for an answer when stdin is not the
// terminal, never asks in CI, in agent mode or with --no-input (the caller gets ErrNoTerminal and exits 3 naming the
// flag that answers it), and offers an accessible mode for screen readers.
//
// The Prompter here is a plain line-based fallback; the design system installs the full one (huh) with
// SetPrompter.
package prompt

import (
	"bufio"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

// ErrNoTerminal means there is no one to ask.
var ErrNoTerminal = errors.New("no terminal to ask on")

// Option is one choice in a Select or MultiSelect.
type Option struct {
	Label string
	// Description is a plain explanation shown beside or under the label.
	Description string
	Value       string
}

// Prompter asks questions.
type Prompter interface {
	// Confirm asks a yes/no question; def is the answer Enter gives.
	Confirm(q string, def bool) (bool, error)
	// Select asks for one option and returns its index; def is selected first.
	Select(q string, options []Option, def int) (int, error)
	// MultiSelect asks for any number of options and returns their indexes.
	MultiSelect(q string, options []Option, selected []int) ([]int, error)
	// Input asks for a line of text.
	Input(q, def string) (string, error)
}

var current func(io *iostreams.IOStreams) Prompter = func(io *iostreams.IOStreams) Prompter { return &lines{io: io} }

// SetPrompter replaces the prompter (the design system's huh prompts).
func SetPrompter(p func(io *iostreams.IOStreams) Prompter) { current = p }

// For returns the prompter for the streams, or ErrNoTerminal when nobody may be asked.
func For(io *iostreams.IOStreams) (Prompter, error) {
	if !io.CanPrompt() {
		return nil, ErrNoTerminal
	}
	return current(io), nil
}

// lines is the plain fallback: one question per line on stderr, answers read from stdin (which CanPrompt has
// established is the terminal).
type lines struct {
	io *iostreams.IOStreams
	r  *bufio.Reader
}

func (l *lines) read() (string, error) {
	if l.r == nil {
		l.r = bufio.NewReader(l.io.In)
	}
	s, err := l.r.ReadString('\n')
	if err != nil && s == "" {
		return "", err
	}
	return strings.TrimSpace(s), nil
}

func (l *lines) Confirm(q string, def bool) (bool, error) {
	hint := "y/N"
	if def {
		hint = "Y/n"
	}
	fmt.Fprintf(l.io.ErrOut, "? %s [%s] ", q, hint)
	s, err := l.read()
	if err != nil {
		return false, err
	}
	switch strings.ToLower(s) {
	case "":
		return def, nil
	case "y", "yes":
		return true, nil
	}
	return false, nil
}

func (l *lines) Select(q string, options []Option, def int) (int, error) {
	fmt.Fprintf(l.io.ErrOut, "? %s\n", q)
	for i, o := range options {
		mark := " "
		if i == def {
			mark = ">"
		}
		fmt.Fprintf(l.io.ErrOut, "  %s %d. %s", mark, i+1, o.Label)
		if o.Description != "" {
			fmt.Fprintf(l.io.ErrOut, " (%s)", o.Description)
		}
		fmt.Fprintln(l.io.ErrOut)
	}
	fmt.Fprintf(l.io.ErrOut, "  Number [%d]: ", def+1)
	s, err := l.read()
	if err != nil {
		return 0, err
	}
	if s == "" {
		return def, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > len(options) {
		return def, nil
	}
	return n - 1, nil
}

func (l *lines) MultiSelect(q string, options []Option, selected []int) ([]int, error) {
	fmt.Fprintf(l.io.ErrOut, "? %s\n", q)
	for i, o := range options {
		fmt.Fprintf(l.io.ErrOut, "  %d. %s", i+1, o.Label)
		if o.Description != "" {
			fmt.Fprintf(l.io.ErrOut, " (%s)", o.Description)
		}
		fmt.Fprintln(l.io.ErrOut)
	}
	fmt.Fprint(l.io.ErrOut, "  Numbers, separated by commas: ")
	s, err := l.read()
	if err != nil {
		return nil, err
	}
	if s == "" {
		return selected, nil
	}
	var out []int
	for _, p := range strings.Split(s, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil && n >= 1 && n <= len(options) {
			out = append(out, n-1)
		}
	}
	return out, nil
}

func (l *lines) Input(q, def string) (string, error) {
	if def != "" {
		fmt.Fprintf(l.io.ErrOut, "? %s [%s] ", q, def)
	} else {
		fmt.Fprintf(l.io.ErrOut, "? %s ", q)
	}
	s, err := l.read()
	if err != nil {
		return "", err
	}
	if s == "" {
		return def, nil
	}
	return s, nil
}
