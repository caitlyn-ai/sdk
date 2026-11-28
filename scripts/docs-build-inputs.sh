#!/usr/bin/env bash
# What the docs build reads besides the model (scripts/docs-build.sh runs it first): the CLI's channel pointers, and in
# CI the whole history with every tag. docs/site/test/sdk-releases.test.mjs runs it with each pipeline's variables.
#
#   scripts/docs-build-inputs.sh
#
# CLI_CHANNELS (default scripts/cli-channels.sh) is the command that writes build/cli-channels.json; a test gives its own.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
# A build that publishes (the live one, DOCS_LIVE=on, which docs:build sets on main and on v* tags) must not guess:
# when what it reads below can't be read, it fails rather than publish pages that say the wrong thing. Any other build
# (a merge request's preview, `make docs`) warns and carries on.
strict=false
if [ "${DOCS_LIVE:-}" = on ] || [ -n "${CI_COMMIT_TAG:-}" ] || { [ -n "${CI_COMMIT_BRANCH:-}" ] && [ "${CI_COMMIT_BRANCH}" = "${CI_DEFAULT_BRANCH:-main}" ]; }; then strict=true; fi
problem() {
  if [ "$strict" = true ]; then echo "error: $1 This build publishes, so it stops." >&2; exit 1; fi
  echo "warning: $1" >&2
}
# Whether the CLI has a release yet, from its channel pointers (scripts/docs-releases.mjs cliRelease): until it has a
# stable one, every CLI page carries the Beta label, and until it has any, says there is none to install yet.
out="${CLI_CHANNELS_OUT:-build/cli-channels.json}"
rm -f "$out"
"${CLI_CHANNELS:-scripts/cli-channels.sh}" "$out" || problem "could not read the CLI's channel pointers, so the CLI pages would say it has no release yet."
# The Beta labels, the stable-or-beta switches, the install commands and the Changelog's In beta row come from the
# release and beta tags and the history between them (scripts/docs-releases.mjs). A CI checkout can be shallow, with
# only the tags inside its depth: docs:build asks for the whole history (GIT_DEPTH 0), yet its checkouts have been 20
# commits deep, the project's default, and held a beta's tag but no stable one, so the site said there was no stable
# release. So in CI the history is made whole, with every tag, and a build that publishes checks it is.
if [ -n "${CI:-}" ]; then
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
    git fetch --quiet --unshallow --tags origin || problem "could not fetch the whole history and the tags, so the release labels may be wrong."
  else
    git fetch --quiet --tags origin || problem "could not fetch the tags, so the release labels may be wrong."
  fi
  [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = false ] || problem "the checkout is still shallow, so the release labels may be wrong."
  [ -n "$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --merged HEAD 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)" ] || problem "the checkout has no stable release tag, so nothing would be labelled."
fi
