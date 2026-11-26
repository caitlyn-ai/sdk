package ui

import (
	"errors"
	"slices"

	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"

	"github.com/caitlyn-ai/sdk/cli/internal/prompt"
)

// ErrAborted is returned when the person cancels a prompt (Esc or Ctrl-C).
var ErrAborted = errors.New("cancelled")

// Prompter asks questions with huh (12.1): arrow-key prompts on stderr, the selected option's marker in the accent,
// and huh's accessible mode (one plain question per line, for screen readers) with `accessible` in configuration
// or CAITLYN_ACCESSIBLE. It is installed with prompt.SetPrompter; prompt.For has already made sure someone can be
// asked.
type Prompter struct {
	U          *UI
	Accessible bool
}

var _ prompt.Prompter = (*Prompter)(nil)

// Theme is huh's base theme with the CLI's markers: › for the selection, in the accent.
func (p *Prompter) Theme() huh.Theme {
	return huh.ThemeFunc(func(isDark bool) *huh.Styles {
		st := huh.ThemeBase(isDark)
		u := p.U
		marker := u.E(Accent, u.G.Marker) + " "
		st.Focused.SelectSelector = lipgloss.NewStyle().SetString(marker)
		st.Focused.MultiSelectSelector = lipgloss.NewStyle().SetString(marker)
		st.Focused.SelectedPrefix = lipgloss.NewStyle().SetString("[" + u.E(Accent, u.G.Success) + "] ")
		st.Focused.UnselectedPrefix = lipgloss.NewStyle().SetString("[ ] ")
		st.Focused.Title = lipgloss.NewStyle().Bold(Colourful(u.Err) || isANSI(u.Err))
		st.Focused.Description = lipgloss.NewStyle()
		st.Focused.NextIndicator = lipgloss.NewStyle()
		st.Focused.PrevIndicator = lipgloss.NewStyle()
		if full, _ := u.barColours(); full != nil {
			st.Focused.FocusedButton = st.Focused.FocusedButton.Background(full).Foreground(lipgloss.Color("#0a0c0b"))
		}
		st.Blurred = st.Focused
		st.Blurred.SelectSelector = lipgloss.NewStyle().SetString("  ")
		st.Blurred.MultiSelectSelector = lipgloss.NewStyle().SetString("  ")
		return st
	})
}

func (p *Prompter) run(field huh.Field) error {
	io := p.U.IO
	form := huh.NewForm(huh.NewGroup(field)).
		WithTheme(p.Theme()).
		WithAccessible(p.Accessible).
		WithShowHelp(false).
		WithInput(io.In).
		WithOutput(io.ErrOut)
	err := form.Run()
	if errors.Is(err, huh.ErrUserAborted) {
		return ErrAborted
	}
	return err
}

// Confirm asks a yes/no question.
func (p *Prompter) Confirm(q string, def bool) (bool, error) {
	v := def
	err := p.run(huh.NewConfirm().Title(q).Value(&v).Affirmative("Yes").Negative("No"))
	return v, err
}

func (p *Prompter) options(options []prompt.Option) []huh.Option[int] {
	out := make([]huh.Option[int], len(options))
	for i, o := range options {
		label := o.Label
		if o.Description != "" {
			label += "  " + p.U.E(Muted, o.Description)
		}
		out[i] = huh.NewOption(label, i)
	}
	return out
}

// Select asks for one option.
func (p *Prompter) Select(q string, options []prompt.Option, def int) (int, error) {
	v := def
	err := p.run(huh.NewSelect[int]().Title(q).Options(p.options(options)...).Value(&v))
	return v, err
}

// MultiSelect asks for any number of options.
func (p *Prompter) MultiSelect(q string, options []prompt.Option, selected []int) ([]int, error) {
	opts := p.options(options)
	for i := range opts {
		opts[i] = opts[i].Selected(slices.Contains(selected, i))
	}
	v := slices.Clone(selected)
	err := p.run(huh.NewMultiSelect[int]().Title(q).Options(opts...).Value(&v))
	slices.Sort(v)
	return v, err
}

// Input asks for a line of text; an empty answer gives def.
func (p *Prompter) Input(q, def string) (string, error) {
	var v string
	err := p.run(huh.NewInput().Title(q).Placeholder(def).Value(&v))
	if v == "" {
		v = def
	}
	return v, err
}
