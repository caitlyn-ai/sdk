#!/usr/bin/env bash
# Builds the developer docs into build/docs (scripts/docs-build.mjs). A skeleton until lane D2.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/prepare-model.mjs > /dev/null
node scripts/docs-build.mjs
