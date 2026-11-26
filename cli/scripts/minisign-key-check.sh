#!/bin/sh
# Checks CAITLYN_MINISIGN_PUBLIC_KEY before cli:release builds anything. It is the minisign public key every binary
# is built with, the one `caitlyn update` checks a release's manifest with. Unset, GoReleaser builds every binary
# with the placeholder REPLACE_AT_RELEASE_minisign_public_key, which refuses every update, and cli:publish only stops
# on it after the release has been built and signed. So cli:release runs this first.
#
# A minisign public key is one line of base64 holding 42 bytes: the algorithm "Ed", an 8-byte key ID and the 32-byte
# Ed25519 key. It's the second line of the minisign.pub that `minisign -G` writes. In base64, "Ed" is "RW" and then a
# third character from Q, R, S or T: it carries the rest of the "d" and the key ID's first two bits.
#
# The value is checked exactly as it is, never trimmed: cli:publish compares it byte for byte with the key derived
# from the secret, so a stray space or line break must stop the release here, not after the build and signature.
#
# The minisign secret (CLI_MINISIGN_SECRET_ID) isn't checked here: cli:release's role can sign with the KMS key and
# nothing else, so cli:publish, whose role reads the secret, checks the secret against this key before uploading.
#
#   scripts/minisign-key-check.sh
set -eu
key="${CAITLYN_MINISIGN_PUBLIC_KEY:-}"
fail() {
  echo "minisign-key-check: $1. Set the protected variable CAITLYN_MINISIGN_PUBLIC_KEY to the second line of the release key's minisign.pub; nothing was built." >&2
  exit 1
}
tab="$(printf '\t')"
cr="$(printf '\r')"
nl='
'
[ -n "$key" ] || fail "CAITLYN_MINISIGN_PUBLIC_KEY isn't set"
case "$key" in
  *REPLACE_AT_RELEASE* | *__MINISIGN_PUBLIC_KEY__*) fail "CAITLYN_MINISIGN_PUBLIC_KEY is still the placeholder" ;;
  untrusted*) fail "CAITLYN_MINISIGN_PUBLIC_KEY holds minisign.pub's comment line, not its key" ;;
  /*) fail "CAITLYN_MINISIGN_PUBLIC_KEY is a file path ($key): make it a Variable, not a File, holding the key itself" ;;
  *" "* | *"$tab"* | *"$cr"* | *"$nl"*)
    fail "CAITLYN_MINISIGN_PUBLIC_KEY has a space, tab or line break in it, and cli:publish compares it exactly: remove it"
    ;;
esac
# base64 of 42 bytes is 56 characters, no padding
case "$key" in
  *[!A-Za-z0-9+/]*) fail "CAITLYN_MINISIGN_PUBLIC_KEY isn't base64" ;;
esac
[ "${#key}" = 56 ] || fail "CAITLYN_MINISIGN_PUBLIC_KEY is ${#key} characters, not the 56 of a minisign public key"
case "$key" in
  RW[QRST]*) ;;
  *) fail "CAITLYN_MINISIGN_PUBLIC_KEY isn't an Ed25519 minisign key (it doesn't decode to Ed)" ;;
esac
echo "minisign-key-check: CAITLYN_MINISIGN_PUBLIC_KEY is a minisign public key"
