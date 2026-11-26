---
pageType: cli
sinceVersion: 0
resources:
  - agent
  - knowledge-base
integrations:
  - mcp-server
operations: []
---

# AI agents and the CLI

AI coding agents, such as Claude Code, Cursor, Codex and Gemini CLI, drive the CLI as readily as people do. The CLI notices when one is running it and changes how it behaves: no prompts, JSON output, no decoration, and an error that says what to run next. This page is for the person who works with the agent, and for the agent.

## Set up your AI tools

`caitlyn ai setup` makes the AI coding tools you use in a project Caitlyn-aware in one step. It finds each tool from its files in the project, shows you what it would write for it, and writes only what you accept:

| Tool | Found by | Instructions | Skill | Workspace MCP server |
| --- | --- | --- | --- | --- |
| Claude Code | `CLAUDE.md`, `.claude/`, `.mcp.json` | `CLAUDE.md`, as one `@AGENTS.md` line when `AGENTS.md` has the section | `.claude/skills/caitlyn/` | `.mcp.json` |
| Cursor | `.cursor/`, `.cursorrules` | `AGENTS.md` | | `.cursor/mcp.json` |
| Codex | `AGENTS.md`, `.codex/` | `AGENTS.md` | | |
| GitHub Copilot (VS Code) | `.github/copilot-instructions.md`, `.vscode/mcp.json` | `.github/copilot-instructions.md` | | `.vscode/mcp.json` |
| Gemini CLI | `GEMINI.md`, `.gemini/` | `GEMINI.md` | | |

The instructions are [the section below](#tell-your-agent-about-the-cli), the skill is the CLI's own for Claude Code, and the MCP server is [your workspace's](#connect-an-ai-client-to-the-mcp-server). A tool found only on your machine (its command on your `PATH`, or its folder in your home folder) is offered but not chosen. When no tool is found, setup offers `AGENTS.md`, which most tools read. It can also write `.caitlyn.toml`, so that commands run in the project use its workspace; that one is never chosen for you.

<!-- example: examples/cli/connect-an-ai-client.sh#ai-setup -->
```sh
caitlyn ai setup --tools claude-code,cursor --dry-run --jq '.changes[] | "\(.action) \(.file)"'
caitlyn ai setup --tools claude-code,cursor --yes --jq '.changes | length'
cat CLAUDE.md
caitlyn ai setup --check --jq .upToDate
```

<!-- output: examples/cli/connect-an-ai-client.sh -->
```text
create AGENTS.md
create CLAUDE.md
create .claude/skills/caitlyn/SKILL.md
create .claude/skills/caitlyn/references/commands.md
create .mcp.json
create .cursor/mcp.json
6
<!-- caitlyn ai setup: Claude Code reads the Caitlyn CLI section from AGENTS.md -->
@AGENTS.md
true
```

At a terminal, with no flags, it asks which of these you want, lists the plan, and asks before writing; "Show the changes in full" shows every change as a diff.

- **Nothing is written until you agree.** `--dry-run` only shows the plan, and as JSON it carries each change's diff.
- **Running it again is safe.** What is already right isn't changed, and it says so.
- **No credentials go into any file.** An MCP server's entry is its address only, and each tool signs in to the workspace itself. Setup refuses to change a `caitlyn` entry that has `headers` or `env`, which can hold credentials.
- **Everything it writes is marked**, with the CLI's version and the workspace: `caitlyn ai status` reports it, and `caitlyn ai remove` takes it out again, keeping everything else in each file, even in a copy of the repository a teammate cloned. A skill you have edited is only replaced or removed once you agree.
- **The files name the workspace.** For a public repository, `--no-workspace` leaves it out, and the MCP servers and project defaults with it.
- **It writes only inside the project.** Commit the files to share them with your team, or add them to `.gitignore` to keep them to yourself.
- **Keep it current.** After updating the CLI, `caitlyn ai setup --update` regenerates what is set up and adds nothing. In CI, `caitlyn ai setup --check` exits 3 when the committed files are out of date for the CLI the pipeline uses.

`caitlyn auth login` offers to run it, in one question at the end of sign-in, when you sign in at a terminal from a project that uses an AI tool and isn't set up yet. Choose "Don't ask again for this project" and it is remembered in your user folder (`~/.caitlyn/`), never in the repository. Outside a project, or in one where no tool is found, sign-in ends with a one-line reminder instead. Nothing is offered in CI, under an agent, with `--no-input`, or when the output isn't a terminal.

An agent may run `caitlyn ai setup` too: it never asks, prints the plan as JSON, and writes only with `--yes` (see [Safety](#safety)).

## How the CLI knows

The CLI is in agent mode when:

1. `CAITLYN_AGENT=1` is set: the explicit switch, which always wins. `CAITLYN_AGENT=0` turns agent mode off, but only when stdin is a terminal, for a person typing in an IDE's terminal.
2. A variable that only an agent's own commands have is set: `CLAUDE_CODE_CHILD_SESSION`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `GEMINI_CLI`, `OPENCODE`, `AUGMENT_AGENT`, `ANTIGRAVITY_AGENT`, or the general `AI_AGENT=<name>`.
3. A variable an IDE sets in every terminal (`CLAUDECODE`, `CURSOR_TRACE_ID`) is set and stdin is not a terminal: an agent's shell has none, a person's does.

For a tool not listed, set `AI_AGENT=<its name>` or `CAITLYN_AGENT=1` in its environment. `caitlyn commands --json` reports whether agent mode is on, and why, as `agentMode`.

## What changes in agent mode

| | In agent mode |
| --- | --- |
| Prompts | Never. A command that needs an answer exits 3 and its hint names the flag that gives it |
| Output | JSON, even with a terminal attached, unless `--output`, `CAITLYN_OUTPUT` or the profile's `agent_output` says otherwise |
| Decoration | None: no colour, spinners, progress bars, pager or notices |
| Waiting | A `--wait` with no `--timeout` gets 4 minutes, so a wait never outlasts the agent's own tool call; on timeout it exits 9 and prints the command that resumes the wait |
| Errors | One JSON object on stderr, with `exitCode` and a `hint`, even with a terminal attached and whatever `--output` says |

## Errors an agent can act on

Every error carries a hint: the flags that are missing, and complete commands to run next that reuse the identifiers and flags of the command that failed. A placeholder appears only for a value the CLI can't know, such as `<etag>`. An agent always gets errors as JSON on stderr, as do scripts and CI; only a person at a terminal gets a message. `--error-format json` or `CAITLYN_ERROR_FORMAT=json` makes that certain anywhere.

<!-- example: examples/cli/recover-from-errors.sh#stale -->
```sh
# A stale ETag: someone changed the draft after it was read. Exit code 7, and the hint reads it again
caitlyn agents draft update GHT7YRWXPL --if-match '"draft-stale"' --set guidance.instructions=Shorter.
echo "exit code $?"
```

<!-- output: examples/cli/recover-from-errors.sh -->
```text
{"error":{"code":"PRECONDITION_FAILED","detail":"The draft of agent GHT7YRWXPL changed since you read it. Read it again and reapply your change.","exitCode":7,"hint":{"next":[{"run":"caitlyn agents draft get GHT7YRWXPL --query etag","why":"read the current ETag"},{"run":"caitlyn agents draft update GHT7YRWXPL --set guidance.instructions=Shorter. --if-match <etag>","why":"re-apply your change with it"}],"docs":"https://build.caitlyn.ai/cli/reference/agents/draft/#update"},"requestId":"<request-id>","status":412,"title":"The resource has changed","type":"https://build.caitlyn.ai/errors/PRECONDITION_FAILED"}}
exit code 7
```

Branch on the exit code, then follow `hint.next`. [Exit codes](/cli/exit-codes/) lists every code, and [Errors in the CLI](/cli/errors/) what the CLI suggests for each error.

## Finding commands without the docs

The installed CLI describes itself, so an agent always reads the version it is running:

<!-- example: examples/cli/discover-the-cli.sh#commands+help -->
```sh
# The commands that can't be undone
caitlyn commands --json --jq '.commands[] | select(.impact == "destructive" and (.hidden | not)) | .name'

# What agents draft save needs: its required input, and its page
caitlyn help agents draft save --format json --jq '.inputSchema.required'
caitlyn docs agents draft save
```

- `caitlyn commands --json` is every command: its flags with their types and allowed values, whether each is required, its impact, whether it is long-running or beta, the permission and scope it needs, its exit codes and error codes, and its examples. It also lists the MCP servers that suit some work better (`alternatives.mcp`).
- `caitlyn help <command> --format json` is one command with the JSON Schema of its input, for writing a `--from-file` body; `--format markdown` is the same Markdown as its page here.
- [The CLI's llms.txt](/cli/llms.txt) indexes every page of this section; each page is Markdown at its address with `.md` in place of the trailing slash.

## Safety

Every command has an impact class, shown in its help and in `caitlyn commands --json`:

| Class | What it changes | For example |
| --- | --- | --- |
| `read` | Nothing | list, get, watch, compare |
| `write` | Drafts, or the caller's own work | update the draft, save a version, create a document |
| `user-facing` | What other people get | publish a version, set access |
| `destructive` | Something that can't be undone | delete an agent, a version or a document; cancel a batch; reset the draft |

Under an agent, and in CI:

- `user-facing` and `destructive` commands need `--yes` on the command line. Without it they exit 3, with a hint to run `--dry-run` first. `--yes` never comes from an environment variable or a configuration file, so nothing approves a delete in advance.
- The highest-impact commands (deleting an agent or a knowledge base, and publishing) also need `--confirm <id>` naming the exact target, which stops a wrong-target accident in a loop.
- `caitlyn auth token` is refused, so an agent can't copy a token into a file, a log or a prompt.
- `caitlyn ai setup` and `caitlyn ai remove` need `--yes` too, although they are `write` commands: they change the files that tell AI tools how to behave, so the person sees the plan (`--dry-run`) before an agent writes it. Without `--yes` they print the plan and exit 3. They never change agent scopes, and an agent can't choose the project's workspace in `.caitlyn.toml`.
- Signing in stays with the person: an agent may start `caitlyn auth login`, but the approval in the browser is the person's. Sign-in with a device code is refused under an agent, because relaying a code is how device-code phishing works.

## Agent scopes: a seatbelt, not isolation

When you sign in, you choose what an AI agent may do with the profile: read only (the default), everything you can, nothing, or scopes you pick. Under an agent, the CLI asks for a narrower access token with only those scopes, so Caitlyn itself refuses anything outside them. The CLI also checks first, and refuses with exit code 5 and a hint, without sending anything.

Only a browser or device sign-in has a refresh token to narrow. With any other credential (a personal access token saved with `caitlyn auth login --with-token`, an API client's secret, or a workload identity), agent scopes are checked by the CLI alone, and the agent's calls carry the credential's full scopes. `caitlyn auth status` says which applies. Until Caitlyn narrows agent tokens itself, it says that too.

This is a seatbelt against an agent's mistakes, not a wall against a hostile program. The agent runs as you, on your machine, and a program running as you could read the same sign-in. For a hard boundary, give the agent a credential of its own: a personal access token, or an API client, with only the scopes it needs.

## Tell your agent about the CLI

`caitlyn ai setup` puts this section in each tool's own file. To write it into one file yourself, `caitlyn help agents --write` adds it to the project's `AGENTS.md` (or the file `--path` names, such as `CLAUDE.md`), with the profile's workspace filled in and the CLI's version marked under its heading; it replaces an older copy rather than adding a second, shows the change as a diff, and with `--dry-run` only shows it.

```markdown
## Caitlyn CLI

This project manages Caitlyn with the `caitlyn` CLI.

- Discover commands with `caitlyn commands --json`; one command with `caitlyn help <command> --format json`.
- Output is JSON when you run it. Errors are JSON on stderr; follow `hint.next`. Exit codes: https://build.caitlyn.ai/cli/exit-codes/
- What you may do is set by the profile's agent scopes, which the person chose at sign-in: read only unless they chose more. A command outside them exits 5 without sending anything; ask the person rather than changing `agent_scopes` (only a person can).
- Writes change drafts only. `caitlyn agents versions publish` changes what users get: ask the person first.
- Commands marked destructive need `--yes`. Run them with `--dry-run` first and show the person the plan.
- Long waits: pass `--timeout`, and use the printed resume command if it runs out.
- For conversational work from an AI client, use the workspace MCP server: `caitlyn mcp add <client>`.
- Docs for agents: https://build.caitlyn.ai/llms.txt
```

For Claude Code, `caitlyn help agents --format skill --write` writes a skill, `.claude/skills/caitlyn/`, made from the CLI you have installed: the workflows (change the draft, save, publish, roll back), the commands to ask the person about first, and every command in `references/commands.md`.

## Connect an AI client to the MCP server

For an AI client with no shell, or conversational work over one workspace, the workspace's MCP server suits better
than the CLI. `caitlyn mcp add <client>` prints the configuration that connects Claude Code, Cursor or VS Code to your profile's workspace, and with `--write` adds it to the client's file in your project, keeping every other server there:

<!-- example: examples/cli/connect-an-ai-client.sh#mcp -->
```sh
caitlyn mcp add claude-code --output json --jq .command
caitlyn mcp add vscode --write --output json --jq '{file: (.file | split("/") | .[-2:] | join("/")), changed}'
cat .vscode/mcp.json
```

The client then signs you in to the workspace with its own sign-in the first time it connects. The CLI never hands its own sign-in to another program. [Connect an MCP client](/tools/connect-an-mcp-client/) covers that sign-in and what the client may do.

## Next

- [Choose the CLI, an SDK or the MCP server](/how-to-integrate/#choose-the-cli-an-sdk-or-the-mcp-server): when an AI client should use the workspace's MCP server instead.
- [Recover from errors](/cli/recipes/recover-from-errors/): each failure, its exit code and its hint.
- [Command reference](/cli/reference/): every command.
