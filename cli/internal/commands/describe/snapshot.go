package describe

import "github.com/caitlyn-ai/sdk/cli/internal/spec"

// DocsSnapshot is what the docs build reads to publish the CLI's command reference (docs/cli/tree.json): the tree,
// every reference page's Markdown, the reference's start page, the AGENTS.md section, and each operation's input and
// output schemas. This package's tests write it, and fail while it differs from what the CLI describes, so the docs
// can't drift from the binary.
type DocsSnapshot struct {
	About string `json:"about"`
	Tree  *Tree  `json:"tree"`
	// Reference is the command reference's start page, without its title.
	Reference        string  `json:"reference"`
	Pages            []*Page `json:"pages"`
	ExitCodes        string  `json:"exitCodes"`
	AgentsSnippet    string  `json:"agentsSnippet"`
	SkillDescription string  `json:"skillDescription"`
	// Schemas are each generated command's input and output schemas, by command name ("agents draft save"), as
	// `caitlyn help <command> --format json` prints them; the docs publish each at SchemaURL.
	Schemas map[string]map[string]Schema `json:"schemas"`
}

// Snapshot builds the docs snapshot from a tree with every command, hidden ones included.
func Snapshot(t *Tree) *DocsSnapshot {
	m := spec.MustLoad()
	ref := ReferenceMarkdown(t, 1)
	ref = ref[len("# Command reference\n\n"):]
	schemas := map[string]map[string]Schema{}
	for _, c := range t.Commands {
		if c.Operation == "" {
			continue
		}
		op := m.Op(c.Operation)
		if op == nil {
			continue
		}
		s := map[string]Schema{"input": InputSchema(m, op)}
		if op.SSE == nil {
			s["output"] = OutputSchema(m, op)
		}
		schemas[c.Name] = s
	}
	return &DocsSnapshot{
		About:            "Written by the CLI's tests (go test ./internal/commands/describe -run TestDocsSnapshot -update in cli/): the CLI's description of itself, which the docs build turns into the command reference. Do not edit.",
		Tree:             t,
		Reference:        ref,
		Pages:            Pages(t),
		ExitCodes:        ExitCodesMarkdown(),
		AgentsSnippet:    AgentsSnippet(""),
		SkillDescription: SkillDescription,
		Schemas:          schemas,
	}
}
