#!/usr/bin/env bash
# Point an AI client at the workspace's MCP server, and give an AI coding agent the CLI's AGENTS.md section.
set -euo pipefail
cd "$(mktemp -d)"

# #region mcp
caitlyn mcp add claude-code --output json --jq .command
caitlyn mcp add vscode --write --output json --jq '{file: (.file | split("/") | .[-2:] | join("/")), changed}'
cat .vscode/mcp.json
# #endregion

# #region agents-md
caitlyn help agents --write --output json --jq '.written | length'
head -3 AGENTS.md
# #endregion
