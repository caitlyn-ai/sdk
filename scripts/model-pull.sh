#!/usr/bin/env bash
# Replaces the committed model snapshot (model/model.json, model/openapi.json, model/PROTOCOL.md) and
# model/model.lock.json with a published model, or with a local model build.
#
#   scripts/model-pull.sh 5.121.0           a version from the app's package registry
#   scripts/model-pull.sh latest            the newest published model
#   scripts/model-pull.sh --from-build DIR  an app checkout's unpublished build (DIR is its smithy/ folder,
#                                           after `make smithy`); @since("next") is stamped as STAMP_NEXT
#
# The registry is the generic package caitlyn-v3-model in the app project (custom-d/caitlyn/platform/caitlyn,
# project 653), which every app release publishes to (smithy/scripts/publish.sh in the app). In CI the job
# token reads it; locally set GITLAB_TOKEN to a personal access token with read_api.
# Run `make generate` afterwards; the generated code is committed with the new snapshot.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
api="${CI_API_V4_URL:-https://git.customd.com/api/v4}"
project="${MODEL_PROJECT_ID:-653}"
package="${MODEL_PACKAGE:-caitlyn-v3-model}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

auth_header() {
  if [ -n "${CI_JOB_TOKEN:-}" ]; then echo "JOB-TOKEN: ${CI_JOB_TOKEN}"
  elif [ -n "${GITLAB_TOKEN:-}" ]; then echo "PRIVATE-TOKEN: ${GITLAB_TOKEN}"
  else echo "Set GITLAB_TOKEN (a personal access token with read_api) to read the package registry." >&2; exit 1
  fi
}

fetch() {
  local version="$1" name="$2"
  curl -fsS --retry 3 --header "$(auth_header)" -o "$tmp/$name" \
    "${api}/projects/${project}/packages/generic/${package}/${version}/${name}"
}

if [ "${1:-}" = "--from-build" ]; then
  dir="${2:?Usage: model-pull.sh --from-build <app smithy/ folder>}"
  cp "$dir/build/smithy/source/model/model.json" "$tmp/model.json"
  cp "$dir/build/smithy/openapi/openapi/Caitlyn.openapi.json" "$tmp/openapi.json"
  cp "$dir/PROTOCOL.md" "$tmp/PROTOCOL.md"
  commit="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  version=null
  source="local build of branch ${branch} at commit ${commit} (not published)"
else
  requested="${1:?Usage: model-pull.sh <version>|latest|--from-build <dir>}"
  fetch "$requested" model.json
  fetch "$requested" openapi.json
  fetch "$requested" caitlyn-v3-model.tar.gz
  tar -xzf "$tmp/caitlyn-v3-model.tar.gz" -C "$tmp" PROTOCOL.md
  # `latest` is copied from a numbered version; record which one, from the highest @since it carries.
  version="\"$(node -e "
    const s = require('$tmp/model.json').shapes; let v = '0.0.0';
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
    for (const sh of Object.values(s)) for (const t of [sh.traits, ...Object.values(sh.members ?? {}).map((m) => m.traits)]) { const x = t?.['ai.caitlyn.traits#since']; if (x && x !== 'next' && cmp(x, v) > 0) v = x; }
    process.stdout.write('$requested' === 'latest' ? v : '$requested');
  ")\""
  source="package registry ${package}/${requested}"
fi

if grep -q '"ai.caitlyn.traits#since": "next"' "$tmp/model.json" && [ "$version" != null ]; then
  echo "The published model ${version} contains @since(\"next\"); the app's release should have stamped it." >&2
  exit 1
fi
stamp_next="${STAMP_NEXT:-$(node -p "require('$root/model/model.lock.json').stampNext ?? ''")}"
sha="$(shasum -a 256 "$tmp/model.json" 2>/dev/null | cut -d' ' -f1 || sha256sum "$tmp/model.json" | cut -d' ' -f1)"
cp "$tmp/model.json" "$tmp/openapi.json" "$tmp/PROTOCOL.md" "$root/model/"
cat > "$root/model/model.lock.json" <<JSON
{
  "package": "${package}",
  "registryProject": "custom-d/caitlyn/platform/caitlyn",
  "version": ${version},
  "source": "${source}",
  "sha256": "${sha}",
  "stampNext": $( [ "$version" = null ] && echo "\"${stamp_next}\"" || echo null )
}
JSON
echo "model: ${source} (${sha:0:12}). Now run: make generate"
