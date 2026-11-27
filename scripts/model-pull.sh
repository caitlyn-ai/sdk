#!/usr/bin/env bash
# Replaces the committed model snapshot (model/model.json, model/openapi.json, model/PROTOCOL.md) and
# model/model.lock.json with a published model, or with a local model build. It also keeps, in
# model/changes/<version>.json, the changes.json the app publishes beside each release's model (what changed in the
# public API since the release before), for the developer site's Changelog: a pull keeps every published version's
# after the previous lock's version, up to and including the one it pulls (scripts/model-changes.mjs), so a skipped
# release's changes are kept too. The files accumulate across pulls. A version published before changes.json existed
# is skipped with a note.
#
#   scripts/model-pull.sh 5.121.0           a version from the app's package registry
#   scripts/model-pull.sh latest            the newest published model
#   scripts/model-pull.sh --from-build DIR  an app checkout's unpublished build (DIR is its smithy/ folder,
#                                           after `make smithy`); @since("next") is stamped as STAMP_NEXT, or as
#                                           the previous lock's stampNext. Its build/changes.json is kept when the
#                                           build has one; otherwise model/changes/ is left as it is
#   scripts/model-pull.sh --prerelease DIR  the same build, as the model:main job does (CONTRIBUTING.md,
#                                           "The model snapshot"): @since("next") is stamped as the app version that
#                                           build's server reports in Caitlyn-Api-Version, its package.json's
#                                           major.minor.patch (STAMP_NEXT overrides it). So the SDK's @since check
#                                           (PROTOCOL.md 9) passes on that app build's own server and refuses
#                                           cleanly on an older one. The lock records it as a prerelease, with the
#                                           app version and commit
#
# The registry is the generic package caitlyn-v3-model in the app project (custom-d/caitlyn/platform/caitlyn,
# project 653), which every app release publishes to (smithy/scripts/publish.sh in the app). In CI the job
# token reads it; locally, GITLAB_TOKEN (a personal access token with read_api) or the developer glab is signed in
# as, as scripts/model-latest.sh reads it.
# Run `make generate` afterwards; the generated code is committed with the new snapshot.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
api="${CI_API_V4_URL:-https://git.customd.com/api/v4}"
project="${MODEL_PROJECT_ID:-653}"
package="${MODEL_PACKAGE:-caitlyn-v3-model}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
changes_dir="$root/model/changes"
# The version the snapshot is locked to before this pull (empty for a local build)
previous="$(node -p "require('$root/model/model.lock.json').version ?? ''" 2>/dev/null || true)"
mkdir -p "$tmp/changes"

# Reads an API path into a file and prints its HTTP status: with the job token in CI or GITLAB_TOKEN by curl, or
# else as the developer glab is signed in as (its OAuth token is not a PRIVATE-TOKEN). Fails when it can't ask.
get() {
  local path="$1" out="$2" header=""
  if [ -n "${CI_JOB_TOKEN:-}" ]; then header="JOB-TOKEN: ${CI_JOB_TOKEN}"
  elif [ -n "${GITLAB_TOKEN:-}" ]; then header="PRIVATE-TOKEN: ${GITLAB_TOKEN}"
  elif command -v glab > /dev/null; then
    if GITLAB_HOST="${CI_SERVER_HOST:-git.customd.com}" glab api "$path" > "$out" 2> "$tmp/glab.err"; then echo 200
    elif grep -q '404' "$tmp/glab.err"; then echo 404
    else echo "Could not read ${path} with glab: sign in with glab auth login, or set GITLAB_TOKEN (read_api)." >&2; return 1
    fi
    return 0
  else echo "Set GITLAB_TOKEN (a personal access token with read_api), or sign in with glab, to read the package registry." >&2; return 1
  fi
  curl -sS --retry 3 -o "$out" -w '%{http_code}' --header "$header" "${api}/${path}" || { echo "Could not reach the package registry." >&2; return 1; }
}

# Reads a path that must be there
need() {
  local status
  status="$(get "$1" "$2")" || exit 1
  [ "$status" = 200 ] || { echo "Could not read ${1} (HTTP ${status})." >&2; exit 1; }
}

fetch() {
  local version="$1" name="$2"
  need "projects/${project}/packages/generic/${package}/${version}/${name}" "$tmp/$name"
}

# Every page of the registry's listing of the package, as one JSON array in $tmp/listing.json
list_versions() {
  local page=1 count
  echo '[]' > "$tmp/listing.json"
  while :; do
    need "projects/${project}/packages?package_type=generic&package_name=${package}&per_page=100&page=${page}" "$tmp/page.json"
    count="$(node -e "
      const fs = require('fs'); const all = JSON.parse(fs.readFileSync('$tmp/listing.json', 'utf8')); const page = JSON.parse(fs.readFileSync('$tmp/page.json', 'utf8'));
      fs.writeFileSync('$tmp/listing.json', JSON.stringify(all.concat(page))); process.stdout.write(String(page.length));
    ")"
    [ "$count" -lt 100 ] && break
    page=$((page + 1))
  done
}

# Fetches one version's changes.json into $tmp/changes/<version>.json; a version published before changes.json
# existed has none, and is skipped with a note. Any other failure stops the pull.
fetch_changes() {
  local v="$1" status
  status="$(get "projects/${project}/packages/generic/${package}/${v}/changes.json" "$tmp/changes/$v.json")" || exit 1
  case "$status" in
    200)
      node -e "const c = require('$tmp/changes/$v.json'); if (c.version !== '$v' || !Array.isArray(c.changes)) { console.error('${package}/${v}/changes.json names version ' + c.version + ', or lists no changes.'); process.exit(1); }"
      ;;
    404)
      rm -f "$tmp/changes/$v.json"
      echo "note: ${package}/${v} has no changes.json (published before the app wrote one), so the Changelog has no API entry for it."
      ;;
    *)
      echo "Reading ${package}/${v}/changes.json failed (HTTP ${status})." >&2
      exit 1
      ;;
  esac
}

prerelease=false
if [ "${1:-}" = "--prerelease" ]; then
  prerelease=true
  set -- --from-build "${2:?Usage: model-pull.sh --prerelease <app smithy/ folder>}"
fi
if [ "${1:-}" = "--from-build" ]; then
  dir="${2:?Usage: model-pull.sh --from-build <app smithy/ folder>}"
  cp "$dir/build/smithy/source/model/model.json" "$tmp/model.json"
  cp "$dir/build/smithy/openapi/openapi/Caitlyn.openapi.json" "$tmp/openapi.json"
  cp "$dir/PROTOCOL.md" "$tmp/PROTOCOL.md"
  if [ -f "$dir/build/changes.json" ]; then
    built="$(node -p "require('$dir/build/changes.json').version ?? ''")"
    if [[ "$built" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      cp "$dir/build/changes.json" "$tmp/changes/$built.json"
    else
      echo "note: $dir/build/changes.json names no release number (\"${built}\"), so model/changes/ is left as it is."
    fi
  fi
  commit="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  version=null
  source="local build of branch ${branch} at commit ${commit} (not published)"
else
  requested="${1:?Usage: model-pull.sh <version>|latest|--from-build <dir>|--prerelease <dir>}"
  fetch "$requested" model.json
  fetch "$requested" openapi.json
  fetch "$requested" caitlyn-v3-model.tar.gz
  tar -xzf "$tmp/caitlyn-v3-model.tar.gz" -C "$tmp" PROTOCOL.md
  # `latest` is copied from a numbered version: record which one, from the version.txt published beside it (the
  # model's highest @since is only the newest release that changed the API, not the release it was published with)
  if [ "$requested" = latest ]; then
    fetch latest version.txt
    version="$(tr -d '[:space:]' < "$tmp/version.txt")"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "${package}/latest/version.txt names no release (\"${version}\")." >&2; exit 1; }
    version="\"${version}\""
  else
    version="\"${requested}\""
  fi
  source="package registry ${package}/${requested}"
  # The changes.json of every published version after the previous lock's, up to and including this one
  list_versions
  keep="$(node "$root/scripts/model-changes.mjs" range "$tmp/listing.json" "$previous" "${version//\"/}" "$changes_dir")"
  for v in $keep; do fetch_changes "$v"; done
fi

if grep -q '"ai.caitlyn.traits#since": "next"' "$tmp/model.json" && [ "$version" != null ]; then
  echo "The published model ${version} contains @since(\"next\"); the app's release should have stamped it." >&2
  exit 1
fi
if [ "$prerelease" = true ]; then
  # The release the app build's server reports (src/helpers/v3/v3Request.ts in the app): its package.json version,
  # without a suffix. A prerelease SDK's new operations then need that server or a newer one.
  app_version="$(node -p "require('$dir/../package.json').version" 2>/dev/null || true)"
  [[ "$app_version" =~ ^([0-9]+\.[0-9]+\.[0-9]+) ]] || { echo "--prerelease: $dir/../package.json has no release version (\"${app_version}\")." >&2; exit 1; }
  app_version="${BASH_REMATCH[1]}"
  stamp_next="${STAMP_NEXT:-$app_version}"
  source="prerelease: ${source}, app ${app_version}"
else
  stamp_next="${STAMP_NEXT:-$(node -p "require('$root/model/model.lock.json').stampNext ?? ''")}"
fi
sha="$(shasum -a 256 "$tmp/model.json" 2>/dev/null | cut -d' ' -f1 || sha256sum "$tmp/model.json" | cut -d' ' -f1)"
cp "$tmp/model.json" "$tmp/openapi.json" "$tmp/PROTOCOL.md" "$root/model/"
if [ -n "$(ls -A "$tmp/changes")" ]; then
  mkdir -p "$changes_dir"
  cp "$tmp/changes/"*.json "$changes_dir/"
  echo "changes: kept $(cd "$tmp/changes" && ls | sed 's/\.json$//' | tr '\n' ' ')in model/changes/"
fi
cat > "$root/model/model.lock.json" <<JSON
{
  "package": "${package}",
  "registryProject": "custom-d/caitlyn/platform/caitlyn",
  "version": ${version},
  "source": "${source}",
  "sha256": "${sha}",
  "stampNext": $( [ "$version" = null ] && echo "\"${stamp_next}\"" || echo null )$( [ "$prerelease" = true ] && printf ',\n  "prerelease": {"appVersion": "%s", "appCommit": "%s"}' "$app_version" "$commit" )
}
JSON
echo "model: ${source} (${sha:0:12}). Now run: make generate"
