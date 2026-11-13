#!/usr/bin/env bash
# The last step of the regenerate job: commits the new model snapshot and generated code on branch
# model/<version>, pushes it and opens a merge request. Runs in CI only, with SDK_BOT_TOKEN (a project
# access token with write_repository and api). A summary of the SDKs' public-API changes is to go in the
# description.
set -euo pipefail
: "${SDK_BOT_TOKEN:?SDK_BOT_TOKEN is not set: a project access token with write_repository and api}"
: "${CI_API_V4_URL:?}" "${CI_PROJECT_ID:?}" "${CI_SERVER_HOST:?}" "${CI_PROJECT_PATH:?}" "${CI_DEFAULT_BRANCH:?}"
version="$(node -p "require('./model/model.lock.json').version ?? 'unpublished'")"
branch="model/${version}"
git config user.name "Caitlyn SDK bot"
git config user.email "sdk-bot@noreply.${CI_SERVER_HOST}"
git checkout -B "$branch"
git add model typescript/packages/sdk python/caitlyn go conformance/cases
git commit -m "feat(model): regenerate the SDKs from model ${version}" -m "Pulled from the app's package registry by the regenerate job (pipeline ${CI_PIPELINE_ID:-local})."
git push --force "https://oauth2:${SDK_BOT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git" "HEAD:refs/heads/${branch}"
existing=$(curl -fsS --header "PRIVATE-TOKEN: ${SDK_BOT_TOKEN}" \
  "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/merge_requests?state=opened&source_branch=${branch}" | node -p "JSON.parse(require('fs').readFileSync(0)).length")
if [ "$existing" != 0 ]; then
  echo "A merge request for ${branch} is already open; the push updated it."
  exit 0
fi
node -e "
  const body = {
    source_branch: '${branch}', target_branch: '${CI_DEFAULT_BRANCH}', remove_source_branch: true,
    title: 'feat(model): regenerate the SDKs from model ${version}',
    description: 'The app published model ${version}. This merge request updates model/ and regenerates the TypeScript, Python and Go SDKs; every conformance suite passed in the pipeline that opened it.',
  };
  process.stdout.write(JSON.stringify(body));
" | curl -fsS --header "PRIVATE-TOKEN: ${SDK_BOT_TOKEN}" --header "Content-Type: application/json" \
  --data @- "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/merge_requests" > /dev/null
echo "Opened a merge request for ${branch}."
