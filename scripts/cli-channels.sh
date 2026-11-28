#!/usr/bin/env bash
# Fetches the CLI's channel pointers (https://build.caitlyn.ai/releases/cli/channels/<stable|beta>.json, which
# cli/scripts/release-publish.sh moves with each CLI release) into one file, { "stable": "<version>" | null, "beta":
# "<version>" | null }, for the developer docs (scripts/docs-releases.mjs cliRelease). A channel that answers 404 has
# no release yet; any other answer but 200 (a 403 from a misconfigured bucket, a 5xx) is a failure, never "no release".
#   exit 0  written
#   exit 1  a pointer could not be read (nothing written: the docs then say the CLI has no release yet)
set -euo pipefail
out="${1:?Usage: cli-channels.sh <file>}"
base="${CLI_CHANNELS_URL:-https://build.caitlyn.ai/releases/cli/channels}"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
versions=()
for channel in stable beta; do
  status="$(curl -sS --max-time 30 -o "$tmp" -w '%{http_code}' "$base/$channel.json")" || { echo "Could not read the CLI's $channel channel ($base/$channel.json)." >&2; exit 1; }
  case "$status" in
    200) version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$tmp")"
         [ -n "$version" ] || { echo "The CLI's $channel channel names no version." >&2; exit 1; }
         versions+=("\"$version\"") ;;
    404) versions+=(null) ;;
    *) echo "The CLI's $channel channel answered $status." >&2; exit 1 ;;
  esac
done
mkdir -p "$(dirname "$out")"
printf '{"stable": %s, "beta": %s}\n' "${versions[0]}" "${versions[1]}" > "$out"
