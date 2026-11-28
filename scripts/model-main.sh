#!/usr/bin/env bash
# The model:main job: the app's main pipeline triggers it after a merge that changes the app's Smithy model, with
# APP_COMMIT set to that app commit. It builds the model from that commit, regenerates every SDK from it, runs the
# TypeScript, Python, Go and Rust suites and the conformance check, and only when all of them pass commits the new
# snapshot and generated code straight to main and tags that commit with a beta version, v<next>-beta.<n>.
#
# The model belongs to the app; this job is the only way a model change reaches the SDK's main. A change to the
# SDK's own code (generator, runtimes, docs) goes through a merge request as usual.
#
# The beta tag publishes Python (PyPI) and Rust (crates.io) from the GitHub mirror, and tags Go (go/v<version>), with
# no one involved. It stages npm under the `beta` dist-tag, for a maintainer to approve on npmjs.com (CONTRIBUTING.md,
# "Betas"). A stable release is the manual `release` job on a main pipeline.
#
# <next> is the minor version after the last stable tag; <n> counts that version's beta tags. Needs
# GITLAB_TOKEN (the release job's project access token: Maintainer, write_repository and api), which may push to
# main and create the protected v* tags, and a job token the app project allows to read its repository.
set -euo pipefail
: "${APP_COMMIT:?APP_COMMIT is not set: the app commit whose model to build}"
: "${GITLAB_TOKEN:?GITLAB_TOKEN is not set}" "${CI_SERVER_HOST:?}" "${CI_PROJECT_PATH:?}" "${CI_DEFAULT_BRANCH:?}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
app_repo="${APP_REPO:-https://gitlab-ci-token:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/custom-d/caitlyn/platform/caitlyn.git}"
push_url="https://oauth2:${GITLAB_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"

# Start from the newest main: the job runs one at a time (resource_group), but main may have moved since it started.
# It may move again while the suites run; scripts/model-main-publish.sh then pushes nothing.
git fetch -q --tags "$push_url" "$CI_DEFAULT_BRANCH"
git checkout -q -B "$CI_DEFAULT_BRANCH" FETCH_HEAD
base="$(git rev-parse HEAD)"

# The app's model at APP_COMMIT, built with the app's own build script (the toolchain image has Java and Smithy).
app="$(mktemp -d)"
trap 'rm -rf "$app"' EXIT
git -C "$app" init -q
git -C "$app" remote add origin "$app_repo"
git -C "$app" sparse-checkout set --no-cone /smithy/ /package.json
git -C "$app" fetch -q --depth 1 origin "$APP_COMMIT"
git -C "$app" checkout -q FETCH_HEAD
(cd "$app" && bash smithy/scripts/build.sh)

scripts/model-pull.sh --prerelease "$app/smithy"
if git diff --quiet -- model; then
  echo "main already has the model of app commit ${APP_COMMIT}; nothing to do."
  exit 0
fi

stable="$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 | sed 's/^v//')"
next="$(node -p "const [a, b] = '${stable}'.split('.').map(Number); \`\${a}.\${b + 1}.0\`")"
count="$(git tag -l "v${next}-beta.*" | wc -l | tr -d ' ')"
version="${next}-beta.$((count + 1))"
echo "Beta ${version}, from app commit ${APP_COMMIT}."

scripts/generate.sh
node scripts/version.mjs release "$version"
scripts/test-typescript.sh
scripts/test-python.sh
scripts/test-go.sh
scripts/test-rust.sh
node scripts/check-conformance.mjs
git config user.name "Caitlyn SDK bot"
git config user.email "sdk-bot@noreply.${CI_SERVER_HOST}"
# Commits what the suites tested and pushes main and the tag atomically, only if main is still at $base
scripts/model-main-publish.sh "$version" "$base" "$push_url" "$CI_DEFAULT_BRANCH"
node scripts/go-tag.mjs "$version"
