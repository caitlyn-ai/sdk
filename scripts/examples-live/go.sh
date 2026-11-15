#!/usr/bin/env bash
# The Go examples against a real Caitlyn server, for scripts/examples-live.mjs, which runs this in the toolchain
# image with CAITLYN_ENDPOINT, CAITLYN_WORKSPACE, CAITLYN_TOKEN and CAITLYN_AGENT_ID set. examples/go/live calls the
# docs' code in examples/go/operations and prints `ok <check>` or `fail <check>: <why>` for each check.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root/examples/go"
go run ./live
