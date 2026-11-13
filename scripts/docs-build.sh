#!/usr/bin/env bash
# Builds the developer docs into build/docs (scripts/docs-build.mjs): installs the site's pinned packages
# (docs/site/package-lock.json), prepares the model, then builds. Nothing after the install needs the network.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd docs/site && npm ci --no-audit --no-fund --silent && npm test --silent)
node scripts/prepare-model.mjs > /dev/null
# The install instructions name the latest release tag. A CI checkout may not have the tags.
if [ -n "${CI:-}" ] && [ -z "$(git tag --list 'v*' 2>/dev/null)" ]; then git fetch --quiet --tags origin || true; fi
node scripts/docs-build.mjs
