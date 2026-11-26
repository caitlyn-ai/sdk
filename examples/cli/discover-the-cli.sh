#!/usr/bin/env bash
# How an AI agent (or a script) finds its way around the installed CLI, offline: every command as data, one command's
# input schema, its page, and the exit codes.
set -euo pipefail

# #region commands
# The commands that can't be undone
caitlyn commands --json --jq '.commands[] | select(.impact == "destructive" and (.hidden | not)) | .name'
# #endregion

# #region help
# What agents draft save needs: its required input, and its page
caitlyn help agents draft save --format json --jq '.inputSchema.required'
caitlyn docs agents draft save
# #endregion

# #region exit-codes
caitlyn help exit-codes --format json --jq '.exitCodes[] | select(.code == 7) | .meaning'
# #endregion
