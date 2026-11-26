#!/usr/bin/env bash
# Builds the CLI and runs every CLI example (examples/cli/*.sh) against the mock server, comparing what each prints
# with its committed transcript (scripts/cli-examples.mjs). Pass --update to rewrite the transcripts, or example names
# to run only those. Runs in the toolchain image (make cli-examples), which has Go.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/build/cli"
(cd "$root/cli" && go build -o "$root/build/cli/caitlyn" ./cmd/caitlyn)
node "$root/scripts/cli-examples.mjs" --bin "$root/build/cli/caitlyn" "$@"
