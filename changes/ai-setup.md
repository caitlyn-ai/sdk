---
type: feat
scope: cli
summary: caitlyn ai setup sets up your project's AI coding tools to work with Caitlyn, and sign-in offers it
---

- **One command for your AI tools:** `caitlyn ai setup` finds the AI coding tools your project uses (Claude Code,
  Cursor, Codex, GitHub Copilot, Gemini CLI) and gives each the Caitlyn CLI's instructions, Claude Code its skill,
  and each the workspace's MCP server. See [Set up your AI tools](/cli/ai-agents/#set-up-your-ai-tools).
- **Nothing written without you:** it shows every file it would create or change, with the full diff if you ask,
  and writes only once you agree. An AI tool running it gets the plan as JSON and needs `--yes`. No credentials go
  into any file. See [Set up your AI tools](/cli/ai-agents/#set-up-your-ai-tools).
- **Kept up to date, and undone:** `caitlyn ai status` says what is set up and whether it is out of date,
  `caitlyn ai setup --check` fails a CI job when it is, and `caitlyn ai remove` takes it all out again, leaving
  your own content as it was. See [Set up your AI tools](/cli/ai-agents/#set-up-your-ai-tools).
- **Offered at sign-in:** `caitlyn auth login` asks once, when you're in a project with AI tools that isn't set up
  yet. See [Set up your AI tools](/cli/ai-agents/#set-up-your-ai-tools).
- **`help agents --write` shows its change:** it prints a diff of what it wrote, and `--dry-run` shows it without
  writing. See [Tell your agent about the CLI](/cli/ai-agents/#tell-your-agent-about-the-cli).
- **Errors you can read at a terminal:** a person at a terminal now gets errors as a message, with the nearest
  commands and what to run next, even when JSON is the configured output. Scripts, CI and AI agents still get the
  JSON, and `--error-format` or `CAITLYN_ERROR_FORMAT` chooses either. See
  [When something fails](/cli/#when-something-fails).
- **Help after any command:** `caitlyn ai help`, `caitlyn agents draft help` and `caitlyn help ai setup` show the
  same help as `--help`, for every command group, and a mistyped command now suggests the nearest ones. See
  [Finding your way](/cli/#finding-your-way).
