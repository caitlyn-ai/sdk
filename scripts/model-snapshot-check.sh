#!/usr/bin/env bash
# Fails when a change edits the model snapshot (model/) by hand. model/model.json, model/openapi.json and
# model/PROTOCOL.md are copies of the app's model (custom-d/caitlyn/platform/caitlyn, smithy/) that
# scripts/model-pull.sh writes together with model/model.lock.json. A change to model/ that does not change the lock
# file was made here, and the next pull would erase it.
#
#   scripts/model-snapshot-check.sh [BASE]   compares BASE (default: the merge base with origin/main) with HEAD
#
# In a merge request pipeline BASE is CI_MERGE_REQUEST_DIFF_BASE_SHA, the commit the merge request's diff starts
# from. Locally, `make model-snapshot-check` runs it against origin/main.
set -euo pipefail
cd "$(dirname "$0")/.."

base="${1:-${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}}"
if [ -z "$base" ]; then
  base="$(git merge-base origin/main HEAD)"
elif ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=1 origin "$base"
fi

changed="$(git diff --name-only "$base" HEAD -- model/)"
if [ -z "$changed" ] || grep -qx 'model/model.lock.json' <<<"$changed"; then
  echo "model-snapshot-check: model/ is unchanged, or was pulled with scripts/model-pull.sh (the lock file changed too)."
  exit 0
fi

cat >&2 <<MSG
model-snapshot-check: these files under model/ changed, but model/model.lock.json did not:

$(sed 's/^/  /' <<<"$changed")

model/ is a snapshot of the app's model, and the next scripts/model-pull.sh would erase an edit made here. Make
the change in the app repository (https://git.customd.com/custom-d/caitlyn/platform/caitlyn) instead:

  model/PROTOCOL.md   ->  smithy/PROTOCOL.md
  model/model.json    ->  the Smithy sources under smithy/model/ (model.json and openapi.json are built from them)
  model/openapi.json  ->  the same

Then bring it here with scripts/model-pull.sh <version>, or scripts/model-pull.sh --from-build <app checkout>/smithy
for an unpublished build, which updates model/model.lock.json with it, and run make generate (CONTRIBUTING.md,
"The model snapshot").
MSG
exit 1
