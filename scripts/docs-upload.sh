#!/usr/bin/env bash
# Uploads a built site to an S3 prefix the way the hosting expects (production-demo-infrastructure,
# developer-docs/README.md): content-hashed bundles first, then everything else, then deletes what the
# build no longer has, so a reader never gets a page whose bundle is missing. Old _astro bundles are kept, and
# so is _fonts/ (the web fonts the hosting uploads).
#   scripts/docs-upload.sh build/docs/site s3://cd-caitlyn-developer-docs
set -euo pipefail
src="${1:?Usage: docs-upload.sh <site dir> <s3 url>}"
dest="${2:?Usage: docs-upload.sh <site dir> <s3 url>}"
if [ -d "$src/_astro" ]; then
  aws s3 sync "$src/_astro" "$dest/_astro" --cache-control 'public, max-age=31536000, immutable'
fi
aws s3 sync "$src" "$dest" --exclude '_astro/*' --exclude '*.md' --cache-control 'public, max-age=300'
aws s3 sync "$src" "$dest" --exclude '*' --include '*.md' --content-type 'text/markdown; charset=utf-8' --cache-control 'public, max-age=300'
# _fonts/ is never deleted: the hosting uploads the licensed web fonts there (production-demo-infrastructure,
# developer-docs/fonts.tf), and they are not in this repository.
aws s3 sync "$src" "$dest" --delete --exclude '_astro/*' --exclude '_fonts/*'
