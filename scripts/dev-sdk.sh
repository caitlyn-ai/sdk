#!/usr/bin/env bash
# The app's local loop (CONTRIBUTING.md, "The app's local loop"): builds the TypeScript SDK from a model the app has
# just built, into this checkout's gitignored build/dev-sdk/<name>/, so the app can run against it before the model
# is published. The app drives it (`pnpm sdk:local` and its watcher); it is not part of `make generate`, and what it
# writes is never committed: committed generated code comes only from the locked model.
#
# Runs in the toolchain image:
#   scripts/docker.sh scripts/dev-sdk.sh <model.json> <name>
#   docker exec <container> scripts/dev-sdk.sh <model.json> <name>       (CAITLYN_DOCKER_NAME=… scripts/docker.sh)
#
#   <model.json>  a path under this checkout: the app's smithy build output, copied by the app to
#                 build/dev-sdk/<name>/model/source.json
#   <name>        the app worktree's name, [A-Za-z0-9._-]+
#   CAITLYN_LANGS the languages to build: only `typescript` (the default) for now
#
# It writes only under build/dev-sdk/<name>/ (and codegen/build when a generator changed): never a tracked file,
# model/, the lock, conformance/ or a stamped version file. Its output is the two packages, laid out as published:
#   build/dev-sdk/<name>/typescript/packages/sdk        (@caitlyn-ai/sdk)
#   build/dev-sdk/<name>/typescript/packages/sdk-core   (@caitlyn-ai/sdk-core)
# Progress goes to stderr. The last line on stdout is one JSON summary:
#   {"ok":true,"sdkCommit":"<short sha>[-dirty]","modelSha256":"<input's sha256>","packages":{…host paths…},
#    "relative":{…paths from the checkout's root…},"seconds":<n>}
# On failure it exits non-zero with the generator's or the build's error, and the previous build stays in place.
set -euo pipefail
start_ms=$(date +%s%3N)
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
log() { echo "dev-sdk: $*" >&2; }
fail() { echo "dev-sdk: $*" >&2; exit 1; }

[ $# -eq 2 ] || fail "usage: scripts/dev-sdk.sh <model.json> <name>"
model_in="$1"
name="$2"
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] && [ "$name" != . ] && [ "$name" != .. ] || fail "the name must match [A-Za-z0-9._-]+ (not . or ..): $name"
langs="${CAITLYN_LANGS:-typescript}"
[ "$langs" = typescript ] || fail "CAITLYN_LANGS=$langs: only typescript is built for the app's local loop for now"
model_abs="$(cd "$(dirname "$model_in")" 2>/dev/null && pwd)/$(basename "$model_in")" || fail "no such model: $model_in"
[ -f "$model_abs" ] || fail "no such model: $model_in"
case "$model_abs" in "$root"/*) ;; *) fail "the model must be under this checkout ($root): $model_in" ;; esac

out="build/dev-sdk/$name"
mkdir -p "$out"
model_sha="$(sha256sum "$model_abs" | cut -d' ' -f1)"

# 1. The model the generators read, from the given one: no lock check, @since("next") stamped with the lock's
#    stampNext, written to build/dev-sdk/<name>/model/model.json (never build/model/model.json).
node scripts/prepare-model.mjs --dev "$model_abs" "$out/model/model.json" >&2

# 2. The generators, recompiled only when one changed since they were last published (a warm Gradle daemon in a
#    long-lived container keeps this quick). A recompiled generator's Maven copy and Smithy's cached classpath go.
repo="codegen/build/repo"
if [ ! -d "$repo" ] || [ -n "$(find codegen/*/src codegen/*.gradle.kts codegen/*/*.gradle.kts -newer "$repo" -type f -print -quit 2>/dev/null)" ]; then
  log "the generators changed: recompiling them"
  (cd codegen && gradle --quiet publish -x test) >&2
  touch "$repo"
  rm -rf "${HOME}/.m2/repository/ai/caitlyn" "$out/smithy"
fi

# 3. smithy build, TypeScript only, from a config derived from codegen/smithy-build.json.
node -e '
  const fs = require("fs");
  const [, root, out, model] = process.argv;
  const c = JSON.parse(fs.readFileSync(`${root}/codegen/smithy-build.json`, "utf8"));
  c.sources = [model];
  c.maven.repositories = c.maven.repositories.map((r) => (r.url === "file:///work/codegen/build/repo" ? { url: `file://${root}/codegen/build/repo` } : r));
  c.projections = { typescript: c.projections.typescript };
  fs.writeFileSync(`${out}/smithy-build.json`, JSON.stringify(c, null, 2));
' "$root" "$root/$out" "$root/$out/model/model.json"
next="$out/next"
rm -rf "$next"
mkdir -p "$next"
# A build that fails leaves the previous one as it was, and nothing half-built beside it.
trap 'rm -rf "$next"' EXIT
(cd codegen && smithy build --quiet --config "$root/$out/smithy-build.json" --output "$root/$out/smithy") >&2

# 4. A TypeScript workspace laid out as the checkout's typescript/: the generated client (then postgen-ts), sdk-core
#    from this checkout, the build config, and node_modules as links to the checkout's, except @caitlyn-ai/sdk-core,
#    which is this workspace's own (so the client's declarations are checked against the sdk-core built here).
ts="$next/typescript"
mkdir -p "$ts/packages/sdk-core"
cp -R "$out/smithy/typescript/typescript-client-codegen" "$ts/packages/sdk"
cp -R typescript/packages/sdk-core/src typescript/packages/sdk-core/package.json "$ts/packages/sdk-core/"
cp typescript/packages/sdk-core/tsconfig*.json "$ts/packages/sdk-core/" 2>/dev/null || true
cp -R typescript/build-config typescript/README.md "$ts/"
cp LICENSE NOTICE "$next/"
if [ ! -x typescript/node_modules/.bin/tsc ]; then
  log "installing the TypeScript workspace's dependencies (once)"
  (cd typescript && npm ci --no-audit --no-fund --silent) >&2
fi
mkdir -p "$ts/node_modules/@caitlyn-ai"
for entry in "$root"/typescript/node_modules/* "$root"/typescript/node_modules/.bin; do
  [ "$(basename "$entry")" = @caitlyn-ai ] && continue
  ln -s "$entry" "$ts/node_modules/$(basename "$entry")"
done
for entry in "$root"/typescript/node_modules/@caitlyn-ai/*; do
  case "$(basename "$entry")" in sdk-core|sdk) ;; *) ln -s "$entry" "$ts/node_modules/@caitlyn-ai/$(basename "$entry")" ;; esac
done
ln -s ../../packages/sdk-core "$ts/node_modules/@caitlyn-ai/sdk-core"
node scripts/postgen-ts.mjs "$ts" >&2

# 5. The packages' build, with the workspace's root in place of the checkout's.
CAITLYN_TS_ROOT="$root/$ts" node typescript/scripts/build-packages.mjs >&2

# 6. The new build replaces the previous one only now that it has succeeded.
rm -rf "$out/previous"
[ -d "$out/typescript" ] && mv "$out/typescript" "$out/previous"
mv "$ts" "$out/typescript"
for f in LICENSE NOTICE; do mv "$next/$f" "$out/$f"; done
rm -rf "$next" "$out/previous"

commit="$(git -c safe.directory='*' rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "$commit" != unknown ] && [ -n "$(git -c safe.directory='*' status --porcelain --untracked-files=normal 2>/dev/null)" ]; then commit="$commit-dirty"; fi
host="${CAITLYN_HOST_ROOT:-$root}"
end_ms=$(date +%s%3N)
node -e '
  const [, host, out, commit, sha, startMs, endMs] = process.argv;
  const rel = { "@caitlyn-ai/sdk": `${out}/typescript/packages/sdk`, "@caitlyn-ai/sdk-core": `${out}/typescript/packages/sdk-core` };
  const abs = Object.fromEntries(Object.entries(rel).map(([k, v]) => [k, `${host}/${v}`]));
  console.log(JSON.stringify({ ok: true, sdkCommit: commit, modelSha256: sha, packages: abs, relative: rel, seconds: Math.round((Number(endMs) - Number(startMs)) / 100) / 10 }));
' "$host" "$out" "$commit" "$model_sha" "$start_ms" "$end_ms"
