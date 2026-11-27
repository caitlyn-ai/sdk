#!/usr/bin/env bash
# The model-version check: may the SDKs be released from the committed snapshot (model/model.lock.json)? It fetches
# the latest published model and its release number, and scripts/model-check.mjs decides. It fails when the snapshot
# is behind the latest published model, is a hand-pulled unpublished build, or is a model:main pre-release that isn't
# later than the latest release. Usage: scripts/model-check.sh [--strict]
#   exit 0  passes, or no model is published yet
#   exit 2  fails, in a merge request: a warning
#   exit 1  fails with --strict (main and v* tags), or the registry could not be read
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
status=0
"$root/scripts/model-latest.sh" "$tmp/model.json" || status=$?
if [ "$status" = 3 ]; then
  exec node "$root/scripts/model-check.mjs" "$root/model/model.lock.json" "$@"
fi
[ "$status" = 0 ] || exit 1
"$root/scripts/model-latest.sh" "$tmp/version.txt" version.txt || exit 1
exec node "$root/scripts/model-check.mjs" "$root/model/model.lock.json" "$tmp/model.json" "$(cat "$tmp/version.txt")" "$@"
