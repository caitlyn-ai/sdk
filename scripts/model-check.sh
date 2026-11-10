#!/usr/bin/env bash
# The model-version check: is the committed snapshot (model/model.lock.json) the newest published model?
#   exit 0  the snapshot is the latest published model
#   exit 2  behind: a newer model is published (the merge request pipeline shows a warning), or the
#           snapshot is an unpublished build, or nothing is published yet
#   exit 1  the registry could not be read
# The regenerate job (on a trigger from an app release) is what brings the snapshot up to date.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
api="${CI_API_V4_URL:-https://git.customd.com/api/v4}"
project="${MODEL_PROJECT_ID:-653}"
package="${MODEL_PACKAGE:-caitlyn-v3-model}"
if [ -n "${CI_JOB_TOKEN:-}" ]; then header="JOB-TOKEN: ${CI_JOB_TOKEN}"
elif [ -n "${GITLAB_TOKEN:-}" ]; then header="PRIVATE-TOKEN: ${GITLAB_TOKEN}"
else echo "Set GITLAB_TOKEN (read_api) to read the package registry." >&2; exit 1
fi
lock_sha="$(node -p "require('$root/model/model.lock.json').sha256")"
lock_version="$(node -p "require('$root/model/model.lock.json').version ?? 'unpublished'")"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
status=$(curl -sS -o "$tmp" -w '%{http_code}' --header "$header" \
  "${api}/projects/${project}/packages/generic/${package}/latest/model.json") || { echo "Could not reach the package registry." >&2; exit 1; }
if [ "$status" = 404 ]; then
  echo "No model is published yet; the snapshot is ${lock_version}."
  exit 2
fi
if [ "$status" != 200 ]; then
  echo "Could not read ${package}/latest (HTTP ${status}). In CI, the app project must allow this project's job token." >&2
  exit 1
fi
latest_sha="$( (shasum -a 256 "$tmp" 2>/dev/null || sha256sum "$tmp") | cut -d' ' -f1)"
if [ "$latest_sha" = "$lock_sha" ]; then
  echo "The snapshot (${lock_version}) is the latest published model."
  exit 0
fi
echo "The snapshot (${lock_version}, ${lock_sha:0:12}) is not the latest published model (${latest_sha:0:12})."
echo "Run scripts/model-pull.sh latest && make generate, or wait for the regenerate merge request."
exit 2
