// Package gen builds the CLI's generated commands from the command manifest (commands.json): one command per
// method of the SDKs' scope tree, its flags from the operation's input members, and its help from the model's
// documentation, examples, permission, stability and @since (the CLI design, sections 2 and 3).
package gen

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

// Command is a generated command with what its run needs.
type Command struct {
	F        *cmdutil.Factory
	Spec     *spec.Command
	Op       *spec.Operation
	Cobra    *cobra.Command
	Args     []argument
	Idents   []identFlag
	Members  []memberFlag
	Impact   string
	Confirms string
}

// argument is a positional identifier.
type argument struct {
	ID   *spec.Identifier
	Name string
}

// identFlag is an ancestor identifier given as a flag.
type identFlag struct {
	ID      *spec.Identifier
	Flag    string
	Aliases []string
	Default string
}

// Hook lets a hand-written command take over or extend a generated one at the same path: it may replace RunE, add
// flags, or hide it. Registered before Build.
type Hook func(c *Command)

var hooks = map[string][]Hook{}

// AnnotationOwnExamples marks a generated command whose hook gives it examples of its own (its cobra Example): the
// docs show them in place of the model's, keeping only the model's examples of errors.
const AnnotationOwnExamples = "help.examples.own"

// Extend registers a hook for the generated command at path ("knowledge-bases documents create").
func Extend(path string, h Hook) { hooks[path] = append(hooks[path], h) }

// Registry holds every generated command by path and by operation, for `caitlyn api`, hints and the docs.
type Registry struct {
	ByPath map[string]*Command
	ByOp   map[string][]*Command
}

// Current is the registry the last Build made, for `caitlyn api` and the hand-written commands.
var Current *Registry

// byCobra finds the generated command behind a cobra command, for the machine-readable command tree (`caitlyn
// commands`, `caitlyn help --format json`) and the docs, which walk the live tree.
var byCobra sync.Map

// Of returns the generated command behind cmd, or nil for a hand-written or group command.
func Of(cmd *cobra.Command) *Command {
	if c, ok := byCobra.Load(cmd); ok {
		return c.(*Command)
	}
	return nil
}

// FlagMember is the input member a flag sets, and whether it is a secret read from stdin or a file (--x-stdin,
// --x-file). ok is false for a flag no input member is behind (an identifier, --set, --wait and the rest).
func (c *Command) FlagMember(flag string) (m *spec.Member, secret bool, ok bool) {
	for _, mf := range c.Members {
		switch {
		case mf.Flag == flag:
			return mf.Member, mf.Secret, true
		case mf.Secret && (flag == mf.Flag+"-stdin" || flag == mf.Flag+"-file"):
			return mf.Member, true, true
		}
	}
	return nil, false, false
}

// FlagIdentifier is the scope identifier a flag names (--kb gives knowledgeBaseId), or nil.
func (c *Command) FlagIdentifier(flag string) *spec.Identifier {
	for _, id := range c.Idents {
		if id.Flag == flag {
			return id.ID
		}
		for _, a := range id.Aliases {
			if a == flag {
				return id.ID
			}
		}
	}
	return nil
}

// Positionals names the command's positional arguments as its usage line spells them ("agent[@version]"), with the
// identifier each fills.
func (c *Command) Positionals() []Positional {
	out := make([]Positional, 0, len(c.Args)+1)
	for _, a := range c.Args {
		out = append(out, Positional{Name: a.Name, Identifier: a.ID})
	}
	if c.Op != nil && c.Op.UploadTarget != "" {
		out = append(out, Positional{Name: "file", File: true})
	}
	return out
}

// Positional is one positional argument: a scope identifier, or the file an upload command sends.
type Positional struct {
	Name       string
	Identifier *spec.Identifier
	File       bool
}

// Build adds every generated command to root, creating the noun groups between. Groups already on root (hand-written
// ones such as `auth`) are reused.
func Build(root *cobra.Command, f *cmdutil.Factory) (*Registry, error) {
	m, err := spec.Load()
	if err != nil {
		return nil, err
	}
	o, err := spec.LoadOverlay()
	if err != nil {
		return nil, err
	}
	reg := &Registry{ByPath: map[string]*Command{}, ByOp: map[string][]*Command{}}
	for _, sc := range m.Commands {
		parent := root
		for i, noun := range sc.Path[:len(sc.Path)-1] {
			parent = group(parent, noun, sc.Path[:i+1], o, sc.Hidden)
		}
		c := newCommand(f, m, o, sc)
		if c == nil {
			continue
		}
		if existing := find(parent, sc.Verb()); existing != nil {
			return nil, fmt.Errorf("caitlyn %s is both generated and hand-written; extend the generated one with gen.Extend", sc.Name())
		}
		parent.AddCommand(c.Cobra)
		byCobra.Store(c.Cobra, c)
		reg.ByPath[sc.Name()] = c
		if sc.Operation != "" {
			reg.ByOp[sc.Operation] = append(reg.ByOp[sc.Operation], c)
		}
		for _, h := range hooks[sc.Name()] {
			h(c)
		}
	}
	Current = reg
	return reg, nil
}

func find(parent *cobra.Command, name string) *cobra.Command {
	for _, c := range parent.Commands() {
		if c.Name() == name {
			return c
		}
	}
	return nil
}

// group returns the noun command under parent, making it when missing.
func group(parent *cobra.Command, noun string, path []string, o *spec.Overlay, hidden bool) *cobra.Command {
	if c := find(parent, noun); c != nil {
		return c
	}
	c := &cobra.Command{
		Use:     noun,
		Short:   groupShort(path),
		Aliases: o.Aliases[strings.Join(path, " ")],
		Hidden:  hidden,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	parent.AddCommand(c)
	return c
}

func groupShort(path []string) string {
	last := strings.ReplaceAll(path[len(path)-1], "-", " ")
	switch path[len(path)-1] {
	case "core":
		return "Low-level building blocks (uploads, ingestion, operations)"
	case "draft":
		return "An agent's draft: the version you edit"
	case "live":
		return "An agent's live version: what people talk to"
	}
	return "Work with " + last
}

// Impact is a command's impact class (18.5): the overlay's or the model's when given, else read for @readonly
// operations, destructive for deletes, cancels and resets, user-facing for publish and access, write otherwise.
func Impact(o *spec.Overlay, op *spec.Operation, verb string) string {
	if op == nil {
		return "read"
	}
	if c, ok := o.Impact[op.Name]; ok {
		return c
	}
	if op.Impact != "" {
		return op.Impact
	}
	if op.Readonly || op.Method == "GET" || op.Method == "HEAD" {
		return "read"
	}
	switch {
	case op.Method == "DELETE", strings.HasPrefix(verb, "delete"), strings.HasPrefix(verb, "cancel"), verb == "reset":
		return "destructive"
	case verb == "publish", strings.HasSuffix(op.Name, "Access") && op.Method == "PUT":
		return "user-facing"
	}
	return "write"
}

func newCommand(f *cmdutil.Factory, m *spec.Manifest, o *spec.Overlay, sc *spec.Command) *Command {
	var op *spec.Operation
	if sc.Operation != "" {
		op = m.Op(sc.Operation)
		if op == nil {
			return nil
		}
	}
	c := &Command{F: f, Spec: sc, Op: op}
	c.Impact = Impact(o, op, sc.Verb())
	if op != nil {
		c.Confirms = o.Confirm[op.Name]
	}
	taken := map[string]bool{}
	skip := map[string]bool{}
	var use []string
	use = append(use, sc.Verb())
	for _, a := range sc.Args {
		n := o.Name(a.Identifier)
		name := n.Arg
		if a.Compact != nil {
			name += "[@version]"
		}
		c.Args = append(c.Args, argument{ID: a, Name: name})
		use = append(use, "<"+name+">")
		for _, mem := range a.Members {
			skip[mem] = true
		}
		if a.Compact != nil {
			for _, mem := range a.Compact.Members {
				skip[mem] = true
			}
		}
	}
	for _, id := range sc.Identifiers {
		n := o.Name(id.Identifier)
		c.Idents = append(c.Idents, identFlag{ID: id, Flag: n.Flag, Aliases: n.Aliases, Default: n.Default})
		taken[n.Flag] = true
		for _, a := range n.Aliases {
			taken[a] = true
		}
		for _, mem := range id.Members {
			skip[mem] = true
		}
		if id.Compact != nil {
			for _, mem := range id.Compact.Members {
				skip[mem] = true
			}
		}
	}
	for mem := range sc.Fixed {
		skip[mem] = true
	}
	if op != nil {
		c.Members = memberFlags(op, taken, skip)
	}
	short := "Wait until nothing is running on it"
	if op != nil {
		short = op.Title
		if short == "" {
			short = op.Name
		}
	}
	if sc.Verb() == "watch" && op != nil && len(sc.Args) > 0 && sc.Place != "" && !strings.HasSuffix(sc.Place, ".watch") {
		short = "Watch it change"
	}
	if op != nil {
		if marker := spec.MaturityMarker(spec.Maturity(op.Stability)); marker != "" {
			short += "  " + marker
		}
	}
	c.Cobra = &cobra.Command{
		Use:               strings.Join(use, " ") + " [flags]",
		Short:             short,
		Hidden:            sc.Hidden,
		Args:              cobra.MaximumNArgs(len(sc.Args) + extraArgs(op)),
		SilenceUsage:      true,
		ValidArgsFunction: cobra.NoFileCompletions,
		Annotations: map[string]string{
			"generated": "true",
			"impact":    c.Impact,
		},
	}
	if op != nil {
		c.Cobra.Annotations["operation"] = op.Name
		c.Cobra.Annotations["stability"] = op.Stability
		if op.Scope() != "" {
			c.Cobra.Annotations["scope"] = op.Scope()
		}
	}
	c.addFlags(f, m)
	c.Cobra.Long = c.help(f, m, o)
	c.Cobra.Example = c.examples(m, o)
	c.Cobra.RunE = func(cmd *cobra.Command, args []string) error { return c.run(f, cmd, args) }
	return c
}

// extraArgs: an @uploadTarget operation also takes the file as a positional argument.
func extraArgs(op *spec.Operation) int {
	if op != nil && op.UploadTarget != "" {
		return 1
	}
	return 0
}

func (c *Command) addFlags(f *cmdutil.Factory, m *spec.Manifest) {
	fs := c.Cobra.Flags()
	for _, id := range c.Idents {
		usage := "The " + strings.ReplaceAll(spec.Kebab(strings.TrimSuffix(id.ID.Identifier, "Id")), "-", " ")
		if id.ID.Compact != nil {
			usage += ", as AGENT or AGENT@version (AGENT alone means its live version)"
		}
		if id.Default != "" {
			usage += fmt.Sprintf(" (default: %s from configuration)", id.Default)
		}
		fs.String(id.Flag, "", usage)
		for _, a := range id.Aliases {
			fs.String(a, "", "Short for --"+id.Flag)
			_ = fs.MarkHidden(a)
		}
	}
	for _, mf := range c.Members {
		usage := firstSentence(mf.Member.Documentation)
		if mf.Member.Required {
			usage += " (required)"
		}
		if vals := mf.Member.Type.Enum(); len(vals) > 0 {
			usage += " One of: " + strings.Join(vals, ", ") + "."
		}
		if mf.Member.Type.Type == "list" {
			usage += " Repeat the flag, or separate values with commas."
		}
		if mf.Secret {
			fs.Bool(mf.Flag+"-stdin", false, usage+" Read from stdin.")
			fs.String(mf.Flag+"-file", "", usage+" Read from a file.")
			continue
		}
		if mf.Member.Type.Type == "list" {
			stringArray(fs, mf.Flag, usage)
		} else {
			fs.String(mf.Flag, "", usage)
		}
		if vals := mf.Member.Type.Enum(); len(vals) > 0 {
			name := mf.Flag
			_ = c.Cobra.RegisterFlagCompletionFunc(name, func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
				return vals, cobra.ShellCompDirectiveNoFileComp
			})
		}
	}
	if c.Op == nil {
		addWaitFlags(fs, c)
		return
	}
	if hasNested(c.Op) {
		fs.StringArray("set", nil, "Set a nested member: path=value, @file reads a file, json:… parses JSON. Repeatable")
	}
	if hasBody(c.Op) {
		fs.StringP("from-file", "f", "", "The whole input from a JSON or YAML file, or - for stdin. Flags override it")
	}
	if cl := c.Op.Member("clear"); cl != nil {
		fs.StringArray("clear", nil, "Clear a member: "+strings.Join(cl.Type.Member.Enum(), ", ")+". Repeatable")
		vals := cl.Type.Member.Enum()
		_ = c.Cobra.RegisterFlagCompletionFunc("clear", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
			return vals, cobra.ShellCompDirectiveNoFileComp
		})
	}
	if c.Op.IfMatch != nil {
		usage := "Only if the thing still has this ETag (412 otherwise)."
		if c.Op.IfMatch.Required {
			usage += " Required: read it with --query etag"
		} else {
			usage += " Without it, the change applies to the thing as it is now"
		}
		fs.String("if-match", "", usage)
	}
	if c.Op.IdempotencyHd != "" {
		fs.String("idempotency-key", "", "Reuse this key when re-running the same command (default: a new key per run)")
	}
	if len(c.Op.Filterable) > 0 {
		var fields []string
		for field, ops := range c.Op.Filterable {
			for _, o := range ops {
				fields = append(fields, field+"["+o+"]=")
			}
		}
		sort.Strings(fields)
		fs.StringArray("filter", nil, "Filter on the server: field[op]=value, repeatable. Fields: "+strings.Join(fields, ", "))
		_ = c.Cobra.RegisterFlagCompletionFunc("filter", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
			return fields, cobra.ShellCompDirectiveNoSpace | cobra.ShellCompDirectiveNoFileComp
		})
	}
	if c.Op.Paginated != nil {
		fs.Int("limit", 0, "Items per page")
		fs.String("cursor", "", "Start after this cursor (a list's nextCursor)")
		fs.Bool("all", false, "Every page")
		fs.Int("max-items", 0, "Stop after this many items, across pages")
	}
	if c.Op.SSE != nil {
		fs.String("until-match", "", "Exit 0 at the first event this jq expression matches")
		fs.String("timeout", "", "Stop after this long, for example 10m (exit 9)")
	}
	if c.Spec.Estimate != "" {
		fs.Bool("estimate", false, "Print the estimate and send nothing else")
	}
	if c.Op.SSE == nil && c.Impact != "read" {
		fs.Bool("generate-input", false, "Print an input skeleton (YAML) with every member and its documentation")
	}
	if c.Op.SSE == nil && (c.Spec.LongRunning != nil || (c.Spec.ScopeWatch != nil && c.Impact != "read")) {
		addWaitFlags(fs, c)
	}
}

func addWaitFlags(fs interface {
	Bool(string, bool, string) *bool
	String(string, string, string) *string
}, c *Command) {
	if c.Op != nil {
		fs.Bool("wait", false, "Wait until the work it starts has finished, then print the thing")
	}
	fs.String("timeout", "", "The wait's time limit, for example 30m (exit 9 when it passes)")
	fs.Bool("progress", false, "Print progress lines even without a terminal")
}

func hasNested(op *spec.Operation) bool {
	for _, m := range op.Input {
		if (m.Location == "body" || m.Location == "payload") && !m.Type.Scalar() {
			return true
		}
	}
	return false
}

func hasBody(op *spec.Operation) bool {
	for _, m := range op.Input {
		if m.Location == "body" || m.Location == "payload" {
			return true
		}
	}
	return false
}

func firstSentence(doc string) string {
	// pflag reads a `quoted` word in a flag's usage as its value's name: keep the model's code spans as plain quotes
	doc = strings.ReplaceAll(strings.Join(strings.Fields(doc), " "), "`", "'")
	if i := strings.Index(doc, ". "); i > 0 {
		return doc[:i+1]
	}
	return doc
}

// SortedPaths lists the registry's command paths.
func (r *Registry) SortedPaths() []string {
	out := make([]string, 0, len(r.ByPath))
	for p := range r.ByPath {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
