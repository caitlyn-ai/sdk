#!/usr/bin/env bash
# Builds the developer docs into build/docs (scripts/docs-build.mjs): installs the site's pinned packages
# (docs/site/package-lock.json), prepares the model, fetches the latest published model, then builds. Nothing after
# that fetch needs the network.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd docs/site && npm ci --no-audit --no-fund --silent)
node scripts/prepare-model.mjs > /dev/null
# Which operations workspaces serve, and since which release, comes from the latest published model, not the snapshot
# (scripts/docs-model.mjs, publishedModel). If it can't be read, the docs fall back to the snapshot's own @since.
rm -f build/published-model.json
if scripts/model-latest.sh build/published-model.json; then
  echo "Availability: from the latest published model ($(node --input-type=module -e "const { publishedModel } = await import('./scripts/docs-model.mjs'); console.log(publishedModel().since.size)") operations served)."
else
  echo "warning: could not read the latest published model, so availability comes from the snapshot's own @since (model/model.lock.json: $(node -p "require('./model/model.lock.json').version ?? 'unpublished'")). Pages may say an operation is not available when a release already serves it." >&2
fi
# The site's tests: heading ids, language tabs, and the API reference (which reads the prepared model)
(cd docs/site && npm test --silent)
# The install instructions name the latest release tag. A CI checkout may not have the tags.
if [ -n "${CI:-}" ] && [ -z "$(git tag --list 'v*' 2>/dev/null)" ]; then git fetch --quiet --tags origin || true; fi
node scripts/docs-build.mjs
