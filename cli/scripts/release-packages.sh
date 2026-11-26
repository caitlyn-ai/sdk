#!/usr/bin/env bash
# Pushes the Homebrew formula and the Scoop manifest GoReleaser wrote (dist/homebrew, dist/scoop) to
# github.com/caitlyn-ai/homebrew-tap and github.com/caitlyn-ai/scoop-bucket. Run by the cli:packages job only, after
# cli:publish has uploaded the archives they point to, so no package manager is ever pointed at a release that isn't
# there yet (the CLI design, 8.4).
#
#   scripts/release-packages.sh dist <version>
#
# Reads HOMEBREW_TAP_TOKEN and SCOOP_BUCKET_TOKEN (fine-grained GitHub tokens, Contents read and write on their one
# repository). A missing token skips that package manager, and says so. The tokens never appear on a command line or
# in a URL: they go to git as an Authorization header.
set -euo pipefail
dist="${1:?usage: release-packages.sh <dist> <version>}"
version="${2:?usage: release-packages.sh <dist> <version>}"
version="${version#v}"
if [[ "$version" == *-* ]]; then
  echo "release-packages: $version is a prerelease; Homebrew and Scoop carry stable releases only"
  exit 0
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

push() {
  local repo="$1" token="$2" src="$3" dst="$4" pattern="$5"
  if [ -z "$token" ]; then
    echo "release-packages: no token for $repo; skipped" >&2
    return 0
  fi
  [ -f "$src" ] || { echo "release-packages: $src is missing" >&2; return 1; }
  # The header goes to git through its environment (GIT_CONFIG_*), never its arguments, which other processes can read
  local auth
  auth="Authorization: basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$auth"
  git clone --quiet --depth 1 "https://github.com/caitlyn-ai/$repo.git" "$work/$repo"
  # Only forwards: a backport (0.12.4 after 0.13.0) leaves the package at the newer release
  local have
  have="$(sed -n "$pattern" "$work/$repo/$dst" 2> /dev/null | head -n 1 || true)"
  if [ -n "$have" ] && [ "$have" != "$version" ] && [ "$(printf '%s\n%s\n' "$have" "$version" | sort -V | tail -n 1)" = "$have" ]; then
    echo "release-packages: $repo is at $have, newer than $version; left as it is"
    unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
    return 0
  fi
  mkdir -p "$(dirname "$work/$repo/$dst")"
  cp "$src" "$work/$repo/$dst"
  git -C "$work/$repo" add "$dst"
  if git -C "$work/$repo" diff --cached --quiet; then
    echo "release-packages: $repo already has caitlyn $version"
    return 0
  fi
  git -C "$work/$repo" -c user.name=caitlyn-release -c user.email=releases@caitlyn.ai commit --quiet -m "caitlyn $version"
  git -C "$work/$repo" push --quiet origin HEAD
  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
  echo "release-packages: pushed caitlyn $version to $repo"
}

push homebrew-tap "${HOMEBREW_TAP_TOKEN:-}" "$(find "$dist/homebrew" -name caitlyn.rb | head -1)" Formula/caitlyn.rb 's/^ *version "\([^"]*\)".*/\1/p'
push scoop-bucket "${SCOOP_BUCKET_TOKEN:-}" "$(find "$dist/scoop" -name caitlyn.json | head -1)" caitlyn.json 's/^ *"version": *"\([^"]*\)".*/\1/p'
