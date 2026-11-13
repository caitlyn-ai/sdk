#!/usr/bin/env bash
# Rust: rustfmt, clippy (warnings are errors), unit and doc tests and the docs build for the SDK and its runtime,
# clippy over the developer docs' examples,
# then the conformance harness (writes build/conformance/rust.json). Lock files are honoured (--locked).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/build/rust-target}"
mkdir -p "$root/build/conformance"
cd "$root/rust"
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --quiet
RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps --quiet -p caitlyn-sdk -p caitlyn-sdk-core
# The developer docs' Rust: the hand-written examples and the API reference's programs (scripts/docs-snippets.mjs)
cd "$root"
node scripts/prepare-model.mjs > /dev/null
node scripts/docs-snippets.mjs rust
cd "$root/examples/rust"
cargo clippy --locked --all-targets -- -D warnings
cd "$root/conformance/rust"
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --test conformance
