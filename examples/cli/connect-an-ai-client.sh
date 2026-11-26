#!/usr/bin/env bash
# Point an AI client at the workspace's MCP server, and set up a project's AI coding tools to use the CLI.
set -euo pipefail
cd "$(mktemp -d)"

# #region mcp
caitlyn mcp add claude-code --output json --jq .command
caitlyn mcp add vscode --write --output json --jq '{file: (.file | split("/") | .[-2:] | join("/")), changed}'
cat .vscode/mcp.json
# #endregion

# #region ai-setup
caitlyn ai setup --tools claude-code,cursor --dry-run --jq '.changes[] | "\(.action) \(.file)"'
caitlyn ai setup --tools claude-code,cursor --yes --jq '.changes | length'
cat CLAUDE.md
caitlyn ai setup --check --jq .upToDate
# #endregion
