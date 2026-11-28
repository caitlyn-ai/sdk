#!/usr/bin/env bash
# Writes docs/cli/tree.json, the CLI's description of itself that the docs build turns into the command reference,
# from the CLI as it is now (its command manifest, cli/internal/spec/commands.json, which scripts/generate.sh writes
# from the model). The CLI's TestDocsSnapshot fails while the committed file differs, so whatever regenerates the
# manifest runs this too: scripts/model-main.sh after generating. Needs Go (the toolchain image).
set -euo pipefail
cd "$(dirname "$0")/../cli"
go test -count=1 ./internal/commands/describe -run '^TestDocsSnapshot$' -update > /dev/null
echo "cli-tree: docs/cli/tree.json from the CLI's command manifest"
