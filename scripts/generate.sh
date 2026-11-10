#!/usr/bin/env bash
# Regenerates every SDK from the committed model snapshot. Runs in the toolchain image: locally through
# `make generate` (scripts/docker.sh), in CI directly.
#   1. build/model/model.json from model/model.json (scripts/prepare-model.mjs);
#   2. compile the generators and publish them to codegen/build/repo;
#   3. `smithy build` in codegen/, which runs the three generators (codegen/smithy-build.json);
#   4. copy the output into typescript/packages/sdk, python/caitlyn and go/, and tidy it;
#   5. conformance/cases/examples.json from the model's @examples (scripts/gen-example-cases.mjs).
# Generated code is committed: a model change shows up as a reviewable diff.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

node scripts/prepare-model.mjs
node scripts/gen-example-cases.mjs

echo "Compiling the generators"
(cd codegen && gradle --no-daemon --quiet test publish)
# The Smithy CLI copies resolved jars into the local Maven repository and caches the classpath. The
# generators keep one version number while they change, so drop both copies before each build.
rm -rf "${HOME}/.m2/repository/ai/caitlyn" codegen/build/smithy

echo "Running the generators"
(cd codegen && smithy build --quiet --output build/smithy)
out=codegen/build/smithy

echo "TypeScript: typescript/packages/sdk"
rm -rf typescript/packages/sdk
cp -R "$out/typescript/typescript-client-codegen" typescript/packages/sdk
node scripts/postgen-ts.mjs

echo "Python: python/caitlyn"
rm -rf python/caitlyn
cp -R "$out/python/caitlyn-python-client-codegen" python/caitlyn

echo "Go: go/ (generated files only; go/core, go/conformance and go.mod are hand-written)"
for f in go/*.go; do
  [ -e "$f" ] || continue
  head -1 "$f" | grep -q '^// Code generated .* DO NOT EDIT\.$' && rm "$f"
done
cp "$out"/go/caitlyn-go-client-codegen/*.go go/
gofmt -w go/*.go

echo "Generated from $(node -p "require('./model/model.lock.json').version ?? 'an unpublished model'")."
