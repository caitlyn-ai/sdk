#!/usr/bin/env bash
# The CLI's agent evaluation: builds the CLI, runs the harness's tests (with the built CLI, so the scripted agent plays
# every reference solution against it and the mock), then the evaluation itself with the agent given (default
# scripted: offline, no model). In the toolchain image: make cli-agent-eval. CI's live runs pass --agent claude.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/build/cli"
(cd "$root/cli" && go build -o "$root/build/cli/caitlyn" ./cmd/caitlyn)
CAITLYN_BIN="$root/build/cli/caitlyn" node --test "$root"/cli/agent-eval/test/*.test.mjs
node "$root/cli/agent-eval/eval.mjs" --bin "$root/build/cli/caitlyn" "$@"
