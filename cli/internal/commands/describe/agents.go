package describe

import (
	"fmt"
	"sort"
	"strings"
)

// AgentsSnippet is the AGENTS.md (or CLAUDE.md) section that tells an AI coding agent how to use the CLI in this
// project (18.4). workspace, when known, is named in it.
func AgentsSnippet(workspace string) string {
	var b strings.Builder
	b.WriteString("## Caitlyn CLI\n\n")
	if workspace != "" {
		fmt.Fprintf(&b, "This project manages Caitlyn with the `caitlyn` CLI (workspace: %s).\n\n", workspace)
	} else {
		b.WriteString("This project manages Caitlyn with the `caitlyn` CLI.\n\n")
	}
	b.WriteString(`- Discover commands with ` + "`caitlyn commands --json`" + `; one command with ` + "`caitlyn help <command> --format json`" + `.
- Output is JSON when you run it. Errors are JSON on stderr; follow ` + "`hint.next`" + `. Exit codes: https://build.caitlyn.ai/cli/exit-codes/
- What you may do is set by the profile's agent scopes, which the person chose at sign-in: read only unless they chose more. A command outside them exits 5 without sending anything; ask the person rather than changing ` + "`agent_scopes`" + ` (only a person can).
- Writes change drafts only. ` + "`caitlyn agents versions publish`" + ` changes what users get: ask the person first.
- Commands marked destructive need ` + "`--yes`" + `. Run them with ` + "`--dry-run`" + ` first and show the person the plan.
- Long waits: pass ` + "`--timeout`" + `, and use the printed resume command if it runs out.
- For conversational work from an AI client, use the workspace MCP server: ` + "`caitlyn mcp add <client>`" + `.
- Docs for agents: https://build.caitlyn.ai/llms.txt
`)
	return b.String()
}

// SkillFile is one file of the Claude Code skill: its path inside the skill's folder, and its text.
type SkillFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

// SkillDescription is the skill's front-matter description: what the skill is for, which is what decides when an
// agent loads it.
const SkillDescription = "Use the caitlyn CLI to manage a Caitlyn workspace: agents, their drafts, versions and live version, knowledge bases and their documents, conversations and events. Use it when the person asks to change or inspect an agent or a knowledge base, sync documents, publish or roll back a version, or script Caitlyn in CI."

// Skill is the Claude Code skill (18.4): SKILL.md, which teaches the workflows rather than every command, and
// references/commands.md, the command list an agent reads when it needs one. Both are generated from the command
// tree, so they match the installed CLI.
func Skill(t *Tree, workspace string) []SkillFile {
	var b strings.Builder
	b.WriteString("---\nname: caitlyn\ndescription: " + SkillDescription + "\n---\n\n")
	b.WriteString("# Caitlyn CLI\n\n")
	if workspace != "" {
		fmt.Fprintf(&b, "This project's workspace is %s.\n\n", workspace)
	}
	fmt.Fprintf(&b, "Generated from caitlyn %s (Caitlyn API %s). When the CLI is newer, regenerate this skill with `caitlyn ai setup --update`.\n\n", t.CLI.Version, t.CLI.ModelVersion)
	b.WriteString(`## How to work

1. Find the command: ` + "`caitlyn commands --json`" + ` lists every command with its flags, impact and exit codes; ` + "`caitlyn help <command> --format json`" + ` gives one, with its input's JSON Schema. [references/commands.md](references/commands.md) lists them all.
2. Read before you write: ` + "`get`" + ` and ` + "`list`" + ` commands are safe. Output is JSON; filter it with ` + "`--jq`" + ` (no jq binary needed).
3. Run writes with ` + "`--dry-run`" + ` first and show the person what it would send.
4. When a command fails, read the JSON error on stderr and run ` + "`hint.next`" + `: complete commands with this run's identifiers.
5. Never run a ` + "`user-facing`" + ` or ` + "`destructive`" + ` command the person didn't ask for. They need ` + "`--yes`" + `, and the highest-impact ones ` + "`--confirm <id>`" + ` naming the target.
6. Don't ask for tokens or run ` + "`caitlyn auth token`" + `; sign-in is the person's.

## Workflows

### Change an agent safely

Edit the draft, try it, save it as a version, publish, and roll back if needed.

` + "```sh" + `
caitlyn agents draft get <agent> --output json          # read it; note its etag
caitlyn agents draft update <agent> --set guidance.instructions=@instructions.md --if-match '<etag>'
caitlyn agents draft save <agent> --name <version-name> --note "Why"
caitlyn agents versions compare <agent>@live --with-version <version-name>
caitlyn agents versions publish <agent>@<version-name> --note "Reviewed" --dry-run
caitlyn agents versions publish <agent>@<version-name> --note "Reviewed" --yes --confirm <agent>   # only once the person agrees
caitlyn agents history list <agent>
` + "```" + `

Publishing changes what everyone talking to the agent gets: it is ` + "`user-facing`" + `. To roll back, publish the earlier version again.

### Look after a knowledge base

` + "```sh" + `
caitlyn kb list
caitlyn kb documents list --kb <kb> --all --output jsonl
caitlyn kb documents get <document> --kb <kb>
` + "```" + `

### Errors and exit codes

Branch on the exit code: 0 succeeded, 2 a usage error (nothing was sent), 3 an answer is needed (pass the flag the hint names), 4 not signed in, 5 not allowed, 6 not found, 7 conflict or stale (read again, then retry), 8 the workspace is too old, 9 timed out (run the resume command), 10 could not reach Caitlyn, 11 rate limited. The full table: https://build.caitlyn.ai/cli/exit-codes/

### When not to use the CLI

From an AI client with no shell, or for conversational work over one workspace, use the workspace's MCP server: ` + "`caitlyn mcp add <client>`" + ` prints how to connect it. To write code against Caitlyn, use the SDKs.
`)
	// The commands that change what other people get, or can't be undone, named so the agent knows them on sight
	var careful []string
	for _, c := range t.Commands {
		if c.Hidden || c.Kind != "command" || (c.Impact != "user-facing" && c.Impact != "destructive") {
			continue
		}
		careful = append(careful, fmt.Sprintf("- `caitlyn %s` (%s)", c.Name, c.Impact))
	}
	if len(careful) > 0 {
		sort.Strings(careful)
		b.WriteString("\n## Commands to ask about first\n\n")
		b.WriteString(strings.Join(careful, "\n") + "\n")
	}
	return []SkillFile{
		{Path: "SKILL.md", Text: b.String()},
		{Path: "references/commands.md", Text: commandList(t)},
	}
}

// commandList is every visible command, grouped, with its synopsis and impact.
func commandList(t *Tree) string {
	var b strings.Builder
	b.WriteString("# caitlyn commands\n\n")
	b.WriteString("Every command, generated from the CLI. `caitlyn help <command> --format markdown` has one command's flags, examples and exit codes.\n\n")
	b.WriteString("| Command | Impact | Summary |\n| --- | --- | --- |\n")
	for _, c := range t.Commands {
		if c.Hidden || c.Kind != "command" {
			continue
		}
		impact := c.Impact
		if impact == "" {
			impact = "read"
		}
		summary := sentence(c.Summary)
		if c.Beta {
			summary += " (beta)"
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s |\n", cell(c.Usage), impact, cell(summary))
	}
	return b.String()
}
