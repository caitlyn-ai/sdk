#!/usr/bin/env bash
# The Rust examples against a real Caitlyn server: runs examples/rust/src/bin/examples_live.rs, which prints
# `ok <check>` or `fail <check>: <why>` per check. scripts/examples-live.mjs runs this in the toolchain image with
# CAITLYN_ENDPOINT, CAITLYN_WORKSPACE, CAITLYN_TOKEN and CAITLYN_AGENT_ID set.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
# Its own build directory in this checkout: the toolchain image's shared Cargo volume can be mid-build for another checkout.
export CARGO_TARGET_DIR="$root/build/examples-live-rust"
cd "$root/examples/rust"
cargo build --locked --quiet --bin examples_live >&2
# The check lines go to standard output, through descriptor 3; what the examples print goes to standard error.
CAITLYN_EXAMPLES_CHECK_FD=3 exec "$CARGO_TARGET_DIR/debug/examples_live" 3>&1 1>&2
