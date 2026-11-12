#!/usr/bin/env bash
# Regenerates every SDK from the committed model snapshot. Runs in the toolchain image: locally through
# `make generate` (scripts/docker.sh), in CI directly.
#   0. the version in VERSION, stamped into the hand-written files and the generator settings (scripts/version.mjs);
#   1. build/model/model.json from model/model.json (scripts/prepare-model.mjs);
#   2. compile the generators and publish them to codegen/build/repo;
#   3. `smithy build` in codegen/, which runs the four generators (codegen/smithy-build.json);
#   4. copy the output into typescript/packages/sdk, python/caitlyn, go/ and rust/caitlyn-sdk, and tidy it;
#   5. conformance/cases/examples.json from the model's @examples (scripts/gen-example-cases.mjs);
#   6. a check that every file naming the SDK version names the one in VERSION (scripts/version.mjs).
# Generated code is committed: a model change shows up as a reviewable diff.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

node scripts/version.mjs stamp
node scripts/prepare-model.mjs
node scripts/gen-example-cases.mjs

echo "Compiling the generators"
(cd codegen && gradle --no-daemon --quiet test publish)
# The Smithy CLI copies resolved jars into the local Maven repository and caches the classpath. The
# generators keep one version number while they change, so drop both copies before each build.
rm -rf "${HOME}/.m2/repository/ai/caitlyn" codegen/build/smithy

echo "Running the generators"
# smithy-build.json names the generators' file repository as file:///work/codegen/build/repo, the path the
# toolchain image mounts the repository at. CI checks it out elsewhere, so build from a copy that names
# this checkout's own path.
sed "s#file:///work/codegen/build/repo#file://${root}/codegen/build/repo#" codegen/smithy-build.json > codegen/smithy-build.local.json
(cd codegen && smithy build --quiet --config smithy-build.local.json --output build/smithy)
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

echo "Rust: rust/caitlyn-sdk"
rm -rf rust/caitlyn-sdk
cp -R "$out/rust/caitlyn-rust-client-codegen" rust/caitlyn-sdk
rustfmt --edition 2021 --config-path rust/rustfmt.toml rust/caitlyn-sdk/src/lib.rs

node scripts/version.mjs check
node scripts/version.mjs assets
echo "Generated from $(node -p "require('./model/model.lock.json').version ?? 'an unpublished model'")."
