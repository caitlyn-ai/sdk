#!/usr/bin/env bash
# Lays out a GoReleaser build as build.caitlyn.ai/releases/cli/ serves it (the CLI design, 8.4), ready for
# release-publish.sh to sign and upload:
#
#   <out>/releases/<version>/   the archives, packages, checksums and their cosign signature, SBOMs, and manifest.json
#   <out>/channels/<channel>.json
#   <out>/install.sh, <out>/install.ps1
#
#   cd cli && scripts/release-manifest.sh dist ../build/cli-release   (artifacts.json's paths are relative to cli/)
#
# manifest.json's date is the build's (GoReleaser's metadata), so the same build always makes the same manifest: a
# release is immutable, and release-publish.sh accepts a re-run only when its files are the same byte for byte.
#
# manifest.json has one platform per line, so install.sh can read it without jq. It is signed later, by
# release-publish.sh: minisign's key never reaches the job that builds.
set -euo pipefail
dist="${1:?usage: release-manifest.sh <dist> <out>}"
out="${2:?usage: release-manifest.sh <dist> <out>}"
here="$(cd "$(dirname "$0")" && pwd)"
version="$(jq -r .version "$dist/metadata.json")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "release-manifest: $version is not a release version" >&2; exit 1; }
channel=stable
[[ "$version" == *-* ]] && channel=beta
rel="$out/releases/$version"
rm -rf "$out"
mkdir -p "$rel" "$out/channels"

if command -v sha256sum > /dev/null; then sha() { sha256sum "$1" | cut -d' ' -f1; }; else sha() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi
size() { wc -c < "$1" | tr -d ' '; }

# Everything GoReleaser made that a person may want to verify or install
jq -r '.[] | select(.type == "Archive" or .type == "Linux Package" or .type == "Checksum" or .type == "Signature" or .type == "Certificate" or .type == "SBOM") | .path' "$dist/artifacts.json" \
  | while read -r p; do cp "$p" "$rel/"; done

{
  printf '{\n  "version": "%s",\n  "channel": "%s",\n  "date": "%s",\n  "platforms": [\n' "$version" "$channel" "$(jq -r '.date[0:10]' "$dist/metadata.json")"
  first=1
  while IFS=$'\t' read -r os arch name; do
    f="$rel/$name"
    [ "$first" = 1 ] || printf ',\n'
    first=0
    printf '    {"os": "%s", "arch": "%s", "url": "%s", "size": %s, "sha256": "%s"}' "$os" "$arch" "$name" "$(size "$f")" "$(sha "$f")"
  done < <(jq -r '.[] | select(.type == "Archive") | [.goos, .goarch, .name] | @tsv' "$dist/artifacts.json" | sort)
  printf '\n  ]\n}\n'
} > "$rel/manifest.json"
jq -e '.platforms | length == 6' "$rel/manifest.json" > /dev/null || { echo "release-manifest: expected 6 platforms" >&2; cat "$rel/manifest.json" >&2; exit 1; }

printf '{"version": "%s", "manifest": "%s/manifest.json"}\n' "$version" "$version" > "$out/channels/$channel.json"
cp "$here/install.sh" "$here/install.ps1" "$out/"
echo "$out: caitlyn $version on the $channel channel"
