#!/usr/bin/env bash
# Fetches a file of the latest model the app has published (caitlyn-v3-model/latest/<name> in the app's package
# registry: model.json by default, or version.txt, the release it is) to the given file. The developer docs read it to decide which operations workspaces serve, and since which release
# (scripts/docs-model.mjs, publishedModel), whatever model the snapshot is locked to.
#   exit 0  written
#   exit 3  no model is published yet (nothing written)
#   exit 1  the registry could not be read (nothing written)
# In CI it reads with the job token, which the app project must allow; elsewhere with GITLAB_TOKEN (read_api), or as
# the developer glab is signed in as.
set -euo pipefail
out="${1:?Usage: model-latest.sh <file> [model.json|version.txt]}"
name="${2:-model.json}"
api="${CI_API_V4_URL:-https://git.customd.com/api/v4}"
project="${MODEL_PROJECT_ID:-653}"
package="${MODEL_PACKAGE:-caitlyn-v3-model}"
path="projects/${project}/packages/generic/${package}/latest/${name}"
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.err"' EXIT
if [ -n "${CI_JOB_TOKEN:-}" ]; then header="JOB-TOKEN: ${CI_JOB_TOKEN}"
elif [ -n "${GITLAB_TOKEN:-}" ]; then header="PRIVATE-TOKEN: ${GITLAB_TOKEN}"
elif command -v glab > /dev/null; then
  # A developer signed in with glab (its OAuth token is not a PRIVATE-TOKEN)
  if GITLAB_HOST="${CI_SERVER_HOST:-git.customd.com}" glab api "$path" > "$tmp" 2> "$tmp.err"; then status=200
  elif grep -q '404' "$tmp.err"; then status=404
  else echo "Could not read ${package}/latest with glab: sign in with glab auth login, or set GITLAB_TOKEN (read_api)." >&2; exit 1
  fi
else echo "Set GITLAB_TOKEN (read_api), or sign in with glab, to read the package registry." >&2; exit 1
fi
if [ -n "${header:-}" ]; then
  status=$(curl -sS --max-time 60 -o "$tmp" -w '%{http_code}' --header "$header" "${api}/${path}") \
    || { echo "Could not reach the package registry." >&2; exit 1; }
fi
if [ "$status" = 404 ]; then
  echo "No model is published yet." >&2
  exit 3
fi
if [ "$status" != 200 ]; then
  echo "Could not read ${package}/latest (HTTP ${status}). In CI, the app project must allow this project's job token." >&2
  exit 1
fi
if [ "$name" = model.json ]; then
  node -e "const m = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!m.shapes) { console.error('${package}/latest/model.json has no shapes.'); process.exit(1); }" "$tmp"
fi
mkdir -p "$(dirname "$out")"
cp "$tmp" "$out"
