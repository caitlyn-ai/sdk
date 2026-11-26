#!/usr/bin/env bash
# Publishes a release laid out by release-manifest.sh to s3://cd-caitlyn-cli-releases under releases/cli/, served as
# build.caitlyn.ai/releases/cli/ (the CLI design, 8.4): every object's key is its path on build.caitlyn.ai. Run by
# the cli:publish job only, on a protected release tag, with AWS credentials for the release role. Order matters:
# the release's files, then its signed manifest, then the installers and the key, and the channel pointer last, so
# nobody is pointed at a release that isn't all there. A release is immutable: its files are written once (put_once).
#
#   scripts/release-publish.sh build/cli-release
#
# Reads: CLI_RELEASE_BUCKET (default cd-caitlyn-cli-releases), CLI_MINISIGN_SECRET_ID (the Secrets Manager secret
# holding the minisign secret key, unencrypted: Secrets Manager protects it), CLI_DISTRIBUTION_ID (CloudFront, to
# refresh the channel pointers and installers), CAITLYN_MINISIGN_PUBLIC_KEY (the public key cli:release built into
# every binary; the manifest must verify against it), CAITLYN_COSIGN_PUBLIC_KEY (likewise for the cosign key, whose
# public half cli:release wrote to cosign.pub), and a minisign binary on PATH.
set -euo pipefail
src="${1:?usage: release-publish.sh <release dir>}"
bucket_name="${CLI_RELEASE_BUCKET:-cd-caitlyn-cli-releases}"
prefix=releases/cli
# Where the mutable files go (installers, keys, pointers), as s3:// and as the path CloudFront invalidates
bucket="s3://$bucket_name/$prefix"
: "${CLI_MINISIGN_SECRET_ID:?CLI_MINISIGN_SECRET_ID names the minisign key secret}"
: "${CAITLYN_MINISIGN_PUBLIC_KEY:?CAITLYN_MINISIGN_PUBLIC_KEY is the public key the binaries were built with}"
version="$(ls "$src/releases")"
[ "$(printf '%s\n' "$version" | wc -l | tr -d ' ')" = 1 ] || { echo "release-publish: one release at a time" >&2; exit 1; }
rel="$src/releases/$version"
channel=stable
[[ "$version" == *-* ]] && channel=beta

# pointer CHANNEL prints the version a channel points at, or nothing before its first release. Any error but "not
# found" (access denied, throttling, the network) stops the release: it never reads as "no pointer yet".
pointer() {
  local key="$prefix/channels/$1.json" err
  if ! err="$(aws s3api head-object --bucket "$bucket_name" --key "$key" 2>&1 > /dev/null)"; then
    case "$err" in
      *"Not Found"* | *"(404)"* | *NoSuchKey*) return 0 ;;
    esac
    echo "release-publish: couldn't read $key, so nothing was moved: $err" >&2
    return 1
  fi
  aws s3 cp --only-show-errors "s3://$bucket_name/$key" - | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p'
}

# newer_or_same A B: is version A the same as B or newer? A prerelease is older than its release (0.13.0-beta.4 <
# 0.13.0), which sort -V gets wrong, so the release part is compared first.
newer_or_same() {
  local a="$1" b="$2"
  [ "$a" = "$b" ] && return 0
  if [ "${a%%-*}" != "${b%%-*}" ]; then
    [ "$(printf '%s\n%s\n' "${a%%-*}" "${b%%-*}" | sort -V | tail -n 1)" = "${a%%-*}" ]
    return
  fi
  # the same release: the release itself is newest, then prereleases by sort -V
  [[ "$a" != *-* ]] && return 0
  [[ "$b" != *-* ]] && return 1
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n 1)" = "$a" ]
}

# put_once FILE KEY: a release's files are immutable: written only if nothing is at KEY yet (If-None-Match, which the
# bucket policy requires under a version). A file already there that is the same byte for byte is a re-run of this job
# on the same build, and is left alone; anything else stops the release: the version is already published with
# different files, and edges would serve either for a year. Release a new version instead.
put_once() {
  local file="$1" key="$2" err
  if err="$(aws s3api put-object --bucket "$bucket_name" --key "$key" --body "$file" --if-none-match '*' \
    --cache-control "$immutable" --content-type "$(content_type "$file")" 2>&1 > /dev/null)"; then
    return 0
  fi
  case "$err" in
    *PreconditionFailed* | *"(412)"*) ;;
    *)
      echo "release-publish: couldn't write $key: $err" >&2
      return 1
      ;;
  esac
  aws s3 cp --only-show-errors "s3://$bucket_name/$key" "$keys/existing"
  if ! cmp -s "$file" "$keys/existing"; then
    echo "release-publish: $version is already published and its $(basename "$key") differs from this build's. A release is immutable: release a new version." >&2
    return 1
  fi
  echo "release-publish: $key is already published with the same content; left as it is."
}
content_type() {
  case "$1" in
    *.json) echo application/json ;;
    *.txt | *.minisig | *.pub | *.pem | *.sig) echo text/plain ;;
    *.tar.gz) echo application/gzip ;;
    *.zip) echo application/zip ;;
    *) echo application/octet-stream ;;
  esac
}

# Sign the manifest. The secret key lives only in this job's temporary folder.
umask 077
keys="$(mktemp -d)"
trap 'rm -rf "$keys"' EXIT
aws secretsmanager get-secret-value --secret-id "$CLI_MINISIGN_SECRET_ID" --query SecretString --output text > "$keys/minisign.key"
minisign -S -s "$keys/minisign.key" -m "$rel/manifest.json" -x "$rel/manifest.json.minisig" -t "caitlyn $version ($channel)"
minisign -R -s "$keys/minisign.key" -p "$keys/minisign.pub"
pubkey="$(tail -n 1 "$keys/minisign.pub")"
minisign -Vm "$rel/manifest.json" -x "$rel/manifest.json.minisig" -P "$pubkey"
# The binaries verify updates with the key they were built with, not this one: if the two have drifted apart, every
# `caitlyn update` would fail with UPDATE_SIGNATURE_INVALID, so stop here, before anything is uploaded.
if [ "$pubkey" != "$CAITLYN_MINISIGN_PUBLIC_KEY" ] || ! minisign -Vm "$rel/manifest.json" -x "$rel/manifest.json.minisig" -P "$CAITLYN_MINISIGN_PUBLIC_KEY" > /dev/null; then
  echo "release-publish: the Secrets Manager key doesn't match CAITLYN_MINISIGN_PUBLIC_KEY, which the binaries carry" >&2
  exit 1
fi
rm -f "$keys/minisign.key"
umask 022

# The release: immutable at its path (put_once; the bucket is versioned, and the publish role can't delete). The
# manifest goes last, so a release with a manifest has all its files. The manifest is made by cli:release, with the
# build's date, so a retried cli:publish signs the same bytes (Ed25519 and the trusted comment are deterministic).
immutable='public, max-age=31536000, immutable'
for f in "$rel"/*; do
  case "$(basename "$f")" in manifest.json*) continue ;; esac
  put_once "$f" "$prefix/$version/$(basename "$f")"
done
for f in manifest.json manifest.json.minisig; do
  put_once "$rel/$f" "$prefix/$version/$f"
done

# The cosign public key the release was signed with, checked against the one the binaries carry: the same key every
# release, so it is published whatever the channel does.
"$(dirname "$0")/cosign-key-check.sh" "$src/cosign.pub"
aws s3 cp --only-show-errors --cache-control 'public, max-age=300' --content-type text/plain "$src/cosign.pub" "$bucket/cosign.pub"

# The channel pointer last, and only forwards: a backport (0.12.4 after 0.13.0) or a re-run on an old tag publishes
# its files but leaves the pointer where it is. A stable release also moves beta, when beta is older: beta is the
# leading edge. Both pointers are read before anything is written, so a failed read changes nothing.
#
# The release role needs s3:ListBucket on the bucket as well as s3:GetObject: without it, S3 answers a pointer that
# doesn't exist yet (the first release, the first beta) with 403, which can't be told from a real refusal.
short='public, max-age=300'
stable="$(pointer stable)"
beta="$(pointer beta)"
current="$stable"
[ "$channel" = beta ] && current="$beta"
moved="$src/channel-moved"
rm -f "$moved"
if [ -n "$current" ] && ! newer_or_same "$version" "$current"; then
  echo "release-publish: the $channel channel is at $current, newer than $version, so it and the installers stay as they are; $version's files are published."
  exit 0
fi

paths=("/$prefix/cosign.pub")
# The installers carry the public key; the key is published too (also built into the binary). They're what stable
# users run, so only a stable release replaces them (a beta only before there is any stable release), and only with
# a pointer that moves: a backport never replaces them with older ones.
if [ "$channel" = stable ] || [ -z "$stable" ]; then
  for f in install.sh install.ps1; do
    sed "s|__MINISIGN_PUBLIC_KEY__|$pubkey|" "$src/$f" > "$keys/$f"
    aws s3 cp --only-show-errors --cache-control "$short" "$keys/$f" "$bucket/$f"
  done
  aws s3 cp --only-show-errors --cache-control "$short" "$keys/minisign.pub" "$bucket/keys/minisign.pub"
  paths+=("/$prefix/install.sh" "/$prefix/install.ps1" "/$prefix/keys/minisign.pub")
fi

aws s3 cp --only-show-errors --cache-control "$short" --content-type application/json "$src/channels/$channel.json" "$bucket/channels/$channel.json"
paths+=("/$prefix/channels/$channel.json")
if [ "$channel" = stable ]; then
  if [ -z "$beta" ] || newer_or_same "$version" "$beta"; then
    aws s3 cp --only-show-errors --cache-control "$short" --content-type application/json "$src/channels/stable.json" "$bucket/channels/beta.json"
    paths+=("/$prefix/channels/beta.json")
  fi
fi
if [ -n "${CLI_DISTRIBUTION_ID:-}" ]; then
  aws cloudfront create-invalidation --distribution-id "$CLI_DISTRIBUTION_ID" --paths "${paths[@]}" > /dev/null
fi
# For cli:image: latest moves only when this release moved the stable channel (read here, not through the CDN)
echo "$channel" > "$moved"
echo "Published caitlyn $version to $bucket and moved the $channel channel."
