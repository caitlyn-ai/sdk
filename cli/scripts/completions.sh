#!/bin/sh
# Writes the shell completions the archives, packages and Homebrew formula install (GoReleaser's before hook).
# Telemetry, the update notice and CI detection are off: this is a build step, not a person's run.
set -eu
cd "$(dirname "$0")/.."
rm -rf completions
mkdir -p completions
for shell in bash zsh fish powershell; do
  CAITLYN_TELEMETRY=0 CAITLYN_NO_UPDATE_NOTIFIER=1 CAITLYN_CI=off CAITLYN_CONFIG_DIR="$(mktemp -d)" \
    go run ./cmd/caitlyn completion "$shell" > "completions/caitlyn.$shell"
done
