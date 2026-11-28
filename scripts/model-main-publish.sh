#!/usr/bin/env bash
# model:main's last step (scripts/model-main.sh): commits the tested tree to main, tags it with the beta, and pushes
# both, or neither.
#
#   scripts/model-main-publish.sh <version> <base> <push-url> <branch>
#   scripts/model-main-publish.sh - <base> <push-url> <branch>
#
# <version> is the beta (0.12.0-beta.1), <base> the commit of <branch> the job started from, and <push-url> the
# repository it pushes to. `-` in place of a version commits a model change that changes no package as
# `docs(model): …`, with no tag: a release happens only when a package changes (scripts/package-inputs.mjs). scripts/model-main-publish.test.mjs runs it against a local bare repository.
#
# What it commits is what the suites tested. It stages the generated code, the model and every file
# scripts/version.mjs stamps (`node scripts/version.mjs files`, so a file added there is committed with no change
# here), and refuses to commit while any other tracked file differs from <base>: such a file was tested but would
# not be committed. The first model:main run committed without conformance/rust/Cargo.lock, examples/rust/Cargo.lock
# and cli/internal/spec/commands.json, so its tag named 0.11.0 in them and failed release:version.
#
# Main must not have moved. The suites ran on <base>, so a commit on a newer main would be a tree nobody tested, and
# a merge would be one too. When main has moved it stops, pushing nothing, and the job is retried: a retry starts
# from the newest main and regenerates (or finds nothing to do when that main already has the model). The check
# narrows the window; `git push --atomic` closes it. A main that moves between the check and the push makes the push
# non-fast-forward, and the atomic push then refuses the tag too, so no path leaves the tag without main. The first
# run pushed without --atomic: the tag landed and main was refused.
set -euo pipefail
version="${1:?usage: model-main-publish.sh <version> <base> <push-url> <branch>}"
base="${2:?usage: model-main-publish.sh <version> <base> <push-url> <branch>}"
push_url="${3:?usage: model-main-publish.sh <version> <base> <push-url> <branch>}"
branch="${4:?usage: model-main-publish.sh <version> <base> <push-url> <branch>}"
cd "$(dirname "$0")/.."

[ "$(git rev-parse HEAD)" = "$(git rev-parse "$base")" ] || {
  echo "HEAD is $(git rev-parse --short HEAD), not ${base:0:12}: the job's checkout has moved. Nothing was committed or pushed." >&2
  exit 1
}

# One path a line, none with a space, split into words below
stamped="$(node scripts/version.mjs files)"
if [ "$version" = - ]; then node scripts/version.mjs check; else node scripts/version.mjs check "$version"; fi
# shellcheck disable=SC2086
git add -A -- model typescript python go rust conformance/cases codegen cli/internal/spec $stamped
unstaged="$(git diff --name-only)"
if [ -n "$unstaged" ]; then
  echo "These tracked files changed during the job but are not part of what model:main commits, so the commit would" >&2
  echo "not be the tree the suites tested. Nothing was committed or pushed. Add them to scripts/model-main-publish.sh" >&2
  echo "if they belong in the commit, or stop the step that changes them:" >&2
  while IFS= read -r file; do echo "  $file" >&2; done <<<"$unstaged"
  exit 1
fi

if [ "$version" = - ]; then
  git commit -q -m "docs(model): the model of app commit ${APP_COMMIT:0:12}, which changes no package" \
    -m "Pulled by the model:main job (pipeline ${CI_PIPELINE_ID:-local}); every suite passed. No package's inputs changed (scripts/package-inputs.mjs), so there is no beta: the docs read the new model."
  refs=("HEAD:refs/heads/${branch}")
else
  git commit -q -m "feat(model): regenerate the SDKs from app commit ${APP_COMMIT:0:12}" \
    -m "Built from the app's model by the model:main job (pipeline ${CI_PIPELINE_ID:-local}); every suite passed." \
    -m "Beta: v${version}"
  git tag -a "v${version}" -m "Beta ${version}, from app commit ${APP_COMMIT}" HEAD
  refs=("HEAD:refs/heads/${branch}" "refs/tags/v${version}")
fi
what="${branch} $(git rev-parse --short HEAD)"; [ "$version" = - ] || what="${what} and v${version}"

remote="$(git ls-remote "$push_url" "refs/heads/${branch}" | cut -f1)"
if [ "$remote" != "$(git rev-parse "$base")" ]; then
  echo "${branch} moved while this job ran: it was ${base:0:12} and is now ${remote:0:12}. The suites tested a tree on" >&2
  echo "${base:0:12}, so nothing was pushed: no commit and no tag. Retry this job: it starts again from the" >&2
  echo "newest ${branch}, and does nothing if that already has the model of app commit ${APP_COMMIT}." >&2
  exit 1
fi

# Both refs, or neither: a ref the server refuses (main moved after the check above) refuses the tag with it
if ! git push --atomic -q "$push_url" "${refs[@]}"; then
  echo "The push was refused, so nothing changed: not ${what} (an atomic push). If ${branch} moved after the" >&2
  echo "check, retry this job: it starts again from the newest ${branch}." >&2
  exit 1
fi
echo "Pushed ${what}."
