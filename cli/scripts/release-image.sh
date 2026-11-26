#!/bin/sh
# Builds ghcr.io/caitlyn-ai/caitlyn from the release's own linux archives, the bytes cli:release checksummed and
# signed and cli:publish uploaded, never a second build, then signs it with the release key in AWS KMS (the CLI
# design, 8.4). Run by the
# cli:image job only, after cli:publish, with Docker (buildx) and cosign on PATH.
#
#   scripts/release-image.sh build/cli-release
#
# Tags: X.Y.Z always; X.Y and latest not for a prerelease; latest only when this release moved the stable channel
# (build/cli-release/channel-moved, written by release-publish.sh), so a backport never moves it. The image is pushed
# by digest, signed (the multi-platform index and its platform images, cosign sign --recursive) with the release key
# in AWS KMS ($CLI_COSIGN_KEY), and only then tagged: if signing fails, no tag ever names it. Verify with:
#
#   cosign verify --key https://build.caitlyn.ai/releases/cli/cosign.pub ghcr.io/caitlyn-ai/caitlyn:X.Y.Z
set -eu
src="${1:?usage: release-image.sh <release dir>}"
repo=ghcr.io/caitlyn-ai/caitlyn
version="$(ls "$src/releases")"
[ "$(printf '%s\n' "$version" | wc -l)" = 1 ] || { echo "release-image: one release at a time" >&2; exit 1; }
rel="$src/releases/$version"
ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT

# Each linux binary from its archive, after checking the archive against the release's manifest
for arch in amd64 arm64; do
  name="caitlyn_${version}_linux_${arch}.tar.gz"
  want="$(sed -n "s/.*\"url\": \"$name\".*\"sha256\": \"\([0-9a-f]*\)\".*/\1/p" "$rel/manifest.json")"
  have="$(sha256sum "$rel/$name" | cut -d' ' -f1)"
  if [ -z "$want" ] || [ "$want" != "$have" ]; then
    echo "release-image: $name doesn't match the release's manifest (want ${want:-nothing}, have $have)" >&2
    exit 1
  fi
  mkdir -p "$ctx/linux/$arch"
  tar -xzf "$rel/$name" -C "$ctx/linux/$arch" caitlyn
done
cp "$(dirname "$0")/../Dockerfile" "$ctx/Dockerfile"

set -- --tag "$repo:$version"
case "$version" in
  *-*) ;;
  *)
    set -- "$@" --tag "$repo:$(echo "$version" | cut -d. -f1-2)"
    if [ "$(cat "$src/channel-moved" 2> /dev/null)" = stable ]; then
      set -- "$@" --tag "$repo:latest"
    else
      echo "release-image: $version didn't move the stable channel, so latest stays where it is"
    fi
    ;;
esac

docker buildx create --use --name caitlyn-release > /dev/null
# Pushed by digest only: no tag names the image until it is signed, so a failed or cancelled signature leaves every
# tag where it was
docker buildx build --platform linux/amd64,linux/arm64 \
  --output "type=image,name=$repo,push-by-digest=true,name-canonical=true,push=true" \
  --label "org.opencontainers.image.version=$version" \
  --label "org.opencontainers.image.revision=${CI_COMMIT_SHA:-unknown}" \
  --label org.opencontainers.image.source=https://github.com/caitlyn-ai/sdk \
  --metadata-file "$ctx/metadata.json" "$ctx"
digest="$(sed -n 's/.*"containerimage.digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' "$ctx/metadata.json" | head -n 1)"
[ -n "$digest" ] || { echo "release-image: buildx reported no digest" >&2; exit 1; }

# One signature on the index covers every tag that names it
: "${CLI_COSIGN_KEY:?CLI_COSIGN_KEY is the release signing key, such as awskms:///alias/caitlyn-cli-release}"
cosign sign --yes --recursive --key "$CLI_COSIGN_KEY" "$repo@$digest"

# Only now the tags
docker buildx imagetools create "$@" "$repo@$digest"
echo "release-image: signed and tagged $repo@$digest ($*)"
